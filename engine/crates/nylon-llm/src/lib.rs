//! LLM 接入层（Phase 2）：编织分解与冲突检测依赖的对话模型抽象。
//!
//! - [`HttpChatModel`]：OpenAI 兼容 chat/completions 端点（DeepSeek、本地 ollama 均可）；
//! - [`StubChatModel`]：离线固定应答，供集成测试验证接线。
//!
//! 引擎通过 NYLON_LLM_URL / NYLON_LLM_MODEL / NYLON_LLM_API_KEY 配置；
//! 可选 NYLON_LLM_MAX_TOKENS 覆盖输出预算（默认 4096）；
//! 未配置时 LLM 通道关闭（Weave 回退启发式分解、冲突检测为空）。
use std::time::Duration;

/// 对话模型抽象：system+user 输入，返回结构化 JSON。
#[async_trait::async_trait]
pub trait ChatModel: Send + Sync {
    /// 请求模型输出 JSON 对象（后端不支持 json_object 时退化为文本解析）。
    async fn chat_json(&self, system: &str, user: &str) -> Result<serde_json::Value, LlmError>;

    /// 带输出预算的 JSON 请求。默认忽略预算回退 chat_json；
    /// HTTP 后端克隆自身覆盖 max_tokens（画像合并等多实体长输出场景会截断 JSON——
    /// 实测 2 会话评测 58 次画像抽取失败 18 次）。
    async fn chat_json_budget(
        &self,
        system: &str,
        user: &str,
        _max_tokens: u32,
    ) -> Result<serde_json::Value, LlmError> {
        self.chat_json(system, user).await
    }
}

#[derive(Debug)]
pub struct LlmError(pub String);

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "llm: {}", self.0)
    }
}
impl std::error::Error for LlmError {}

// ---------- OpenAI 兼容 HTTP 后端 ----------

pub struct HttpChatModel {
    client: reqwest::Client,
    /// 完整的 chat/completions URL（如 https://api.deepseek.com/chat/completions）。
    url: String,
    model: String,
    api_key: Option<String>,
    /// 是否显式关闭推理（thinking: disabled）。默认读 NYLON_LLM_THINKING_OFF。
    thinking_off: bool,
    max_tokens: u32,
    temperature: Option<f32>,
}

#[derive(serde::Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: [Msg<'a>; 2],
    response_format: RespFmt<'a>,
    /// None 时不发送该字段（k3 等模型只允许 temperature=1，显式发 0 会被拒）
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Thinking<'a>>,
}
#[derive(serde::Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}
#[derive(serde::Serialize)]
struct RespFmt<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}
#[derive(serde::Serialize)]
struct Thinking<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(serde::Deserialize)]
struct ChatResp {
    choices: Vec<Choice>,
}
#[derive(serde::Deserialize)]
struct Choice {
    message: MsgOut,
}
#[derive(serde::Deserialize)]
struct MsgOut {
    content: String,
}

impl HttpChatModel {
    pub fn new(url: impl Into<String>, model: impl Into<String>, api_key: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        HttpChatModel {
            client,
            url: url.into(),
            model: model.into(),
            api_key,
            thinking_off: std::env::var("NYLON_LLM_THINKING_OFF").is_ok(),
            // 默认 4096：1536 在会话级分解（40+ 事件）下频繁截断 JSON，
            // 导致抽象层静默丢空（GitHub issue #1）。短输出场景不受影响——
            // 模型生成完 JSON 即停，预算只是上限。
            max_tokens: 4096,
            temperature: Some(0.0),
        }
    }

    /// 覆盖温度；传 None 则请求不携带 temperature 字段
    /// （kimi-k3 等模型只接受 temperature=1，必须省略该字段）。
    pub fn with_temperature(mut self, t: Option<f32>) -> Self {
        self.temperature = t;
        self
    }

    /// 覆盖推理开关（默认跟 NYLON_LLM_THINKING_OFF 环境变量）。
    /// 强推理模型（deepseek-v4-pro）作答时应保持推理开启，由调用方显式 off=false。
    pub fn with_thinking_off(mut self, off: bool) -> Self {
        self.thinking_off = off;
        self
    }

    /// 覆盖输出预算。推理模型的思考链也占 max_tokens，
    /// 预算太小会烧在思考上导致 JSON 截断（实测 1536 对 v4-pro 长上下文偏紧）。
    pub fn with_max_tokens(mut self, n: u32) -> Self {
        self.max_tokens = n;
        self
    }

    /// 覆盖请求超时（默认 15s）。推理模型长上下文作答可能超过 15s，
    /// 超时会被评测记为答错，强模型口径下必须放宽。
    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.client = reqwest::Client::builder()
            .timeout(Duration::from_secs(secs))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        self
    }
}

/// 从响应文本中取出 JSON 对象（容忍 markdown 代码块包裹等常见输出）。
/// 整段解析失败时尝试抢救被 max_tokens 截断的 `{"key": [...]}` 数组：
/// 括号配对扫描提取每一个完整元素，部分恢复远好于整批丢弃。
fn parse_json_loose(text: &str) -> Result<serde_json::Value, LlmError> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str(t) {
        return Ok(v);
    }
    // 退化：截取第一个 '{' 到最后一个 '}' 之间的片段
    if let (Some(a), Some(b)) = (t.find('{'), t.rfind('}')) {
        if a < b {
            if let Ok(v) = serde_json::from_str(&t[a..=b]) {
                return Ok(v);
            }
        }
    }
    if let Some(v) = salvage_truncated_array(t) {
        return Ok(v);
    }
    Err(LlmError(format!(
        "响应不是 JSON: 头[{}] 尾[{}]",
        &t[..t.len().min(300)],
        &t[t.len().saturating_sub(300)..]
    )))
}

/// 抢救被截断的 `{"key": [完整元素, ...` 数组：按括号/引号配对提取完整元素，
/// 重建为 `{"key": [...]}`。元素支持对象与字符串；一个不完整即停止（后续皆不可信）。
fn salvage_truncated_array(t: &str) -> Option<serde_json::Value> {
    let start = t.find('{')?;
    let bracket = t[start..].find('[')? + start;
    let head = &t[start..bracket];
    // 提取数组键名："key": [ 之间的第一个引号串
    let q1 = head.find('"')?;
    let q2 = head[q1 + 1..].find('"')? + q1 + 1;
    let key = &head[q1 + 1..q2];
    if key.is_empty() {
        return None;
    }
    let bytes = t.as_bytes();
    let mut elems = Vec::new();
    let mut i = bracket + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                match scan_json_object(t, i) {
                    Some((end, v)) => {
                        elems.push(v);
                        i = end;
                    }
                    // 截断点：保留已收集的完整元素，停止扫描
                    None => break,
                }
            }
            b'"' => match scan_json_string(t, i) {
                Some((end, s)) => {
                    elems.push(serde_json::Value::String(s));
                    i = end;
                }
                None => break,
            },
            _ => i += 1,
        }
    }
    if elems.is_empty() {
        return None;
    }
    Some(serde_json::json!({ key: elems }))
}

/// 从 i 处（须为 '{'）做括号配对扫描（跳过字符串内的括号与转义），
/// 返回完整对象解析结果与结束位置；配对不上或解析失败返回 None。
fn scan_json_object(t: &str, i: usize) -> Option<(usize, serde_json::Value)> {
    let bytes = t.as_bytes();
    let mut depth = 0usize;
    let mut j = i;
    while j < bytes.len() {
        match bytes[j] {
            b'"' => {
                let (end, _) = scan_json_string(t, j)?;
                j = end;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let v = serde_json::from_str(&t[i..=j]).ok()?;
                    return Some((j + 1, v));
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

/// 从 i 处（须为 '"'）扫描一个 JSON 字符串字面量，返回结束位置与解码值。
fn scan_json_string(t: &str, i: usize) -> Option<(usize, String)> {
    let bytes = t.as_bytes();
    let mut j = i + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' => j += 1, // 跳过转义字符
            b'"' => {
                let v: String = serde_json::from_str(&t[i..=j]).ok()?;
                return Some((j + 1, v));
            }
            _ => {}
        }
        j += 1;
    }
    None
}

#[async_trait::async_trait]
impl ChatModel for HttpChatModel {
    async fn chat_json_budget(
        &self,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> Result<serde_json::Value, LlmError> {
        // reqwest::Client 内部是 Arc，克隆廉价；只换输出预算
        let bigger = HttpChatModel {
            client: self.client.clone(),
            url: self.url.clone(),
            model: self.model.clone(),
            api_key: self.api_key.clone(),
            thinking_off: self.thinking_off,
            max_tokens,
            temperature: self.temperature,
        };
        bigger.chat_json(system, user).await
    }

    async fn chat_json(&self, system: &str, user: &str) -> Result<serde_json::Value, LlmError> {
        let req = ChatReq {
            model: &self.model,
            messages: [
                Msg {
                    role: "system",
                    content: system,
                },
                Msg {
                    role: "user",
                    content: user,
                },
            ],
            response_format: RespFmt {
                kind: "json_object",
            },
            temperature: self.temperature,
            max_tokens: self.max_tokens,
            // 推理关闭时显式发 thinking: disabled（deepseek-v4-flash 等推理模型
            // 会烧光 token 预算导致 JSON 截断）；默认不开关、由模型自己决定
            thinking: if self.thinking_off {
                Some(Thinking { kind: "disabled" })
            } else {
                None
            },
        };
        let mut rb = self.client.post(&self.url).json(&req);
        if let Some(key) = &self.api_key {
            rb = rb.bearer_auth(key);
        }
        let resp = rb.send().await.map_err(|e| LlmError(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let n = body.len().min(200);
            return Err(LlmError(format!("HTTP {status}: {}", &body[..n])));
        }
        let parsed: ChatResp = resp.json().await.map_err(|e| LlmError(e.to_string()))?;
        let content = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| LlmError("空 choices".into()))?;
        parse_json_loose(&content)
    }
}

// ---------- 离线 Stub（固定应答） ----------

/// 固定返回预置 JSON，供测试验证接线逻辑。
pub struct StubChatModel {
    canned: serde_json::Value,
}

impl StubChatModel {
    pub fn new(canned: serde_json::Value) -> Self {
        StubChatModel { canned }
    }
}

#[async_trait::async_trait]
impl ChatModel for StubChatModel {
    async fn chat_json(&self, _system: &str, _user: &str) -> Result<serde_json::Value, LlmError> {
        Ok(self.canned.clone())
    }
}

/// 从环境变量构建 LLM 通道。
///
/// NYLON_LLM_URL（完整 chat/completions URL）存在时启用；
/// 可选 NYLON_LLM_MODEL（默认 deepseek-v4-flash）与 NYLON_LLM_API_KEY。
pub fn llm_from_env() -> Option<std::sync::Arc<dyn ChatModel>> {
    let url = std::env::var("NYLON_LLM_URL").ok()?;
    let model = std::env::var("NYLON_LLM_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".into());
    let key = std::env::var("NYLON_LLM_API_KEY").ok();
    let m = HttpChatModel::new(url, model, key);
    // NYLON_LLM_MAX_TOKENS：显式覆盖输出预算（会话长输入截断 JSON 时调大）
    let m = match std::env::var("NYLON_LLM_MAX_TOKENS") {
        Ok(v) => match v.parse::<u32>() {
            Ok(n) if n > 0 => m.with_max_tokens(n),
            _ => {
                eprintln!("[llm] NYLON_LLM_MAX_TOKENS={v} 不是正整数，忽略");
                m
            }
        },
        Err(_) => m,
    };
    Some(std::sync::Arc::new(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_returns_canned() {
        let m = StubChatModel::new(serde_json::json!({"conflicts": [0]}));
        let v = m.chat_json("s", "u").await.unwrap();
        assert_eq!(v["conflicts"][0], 0);
    }

    #[test]
    fn parse_json_loose_handles_markdown() {
        // raw string avoids escape issues: input is markdown-wrapped JSON
        let v = parse_json_loose(
            r#"```json
{"a": 1}
```"#,
        )
        .unwrap();
        assert_eq!(v["a"], 1);
        let v = parse_json_loose(r#"{"b": 2}"#).unwrap();
        assert_eq!(v["b"], 2);
        assert!(parse_json_loose("b9;䷧ JSON").is_err());
    }

    #[test]
    fn parse_json_loose_salvages_truncated_object_array() {
        // max_tokens 截断：第三个对象写了一半 —— 抢救前两个完整对象
        let truncated = r#"{"facts": [{"fact": "a", "source": ["t:1"]}, {"fact": "b", "source": ["t:2"]}, {"fact": "c", "sou"#;
        let v = parse_json_loose(truncated).unwrap();
        let facts = v["facts"].as_array().unwrap();
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0]["fact"], "a");
        assert_eq!(facts[1]["source"][0], "t:2");
    }

    #[test]
    fn parse_json_loose_salvages_truncated_string_array() {
        let truncated = r#"{"inferences": ["甲对咖啡因敏感", "乙上周搬去了杭州", "丙"#;
        let v = parse_json_loose(truncated).unwrap();
        let arr = v["inferences"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1], "乙上周搬去了杭州");
    }

    #[test]
    fn parse_json_loose_salvage_handles_braces_inside_strings() {
        // 字符串里的花括号不得干扰配对
        let truncated = r#"{"facts": [{"fact": "配置格式是 {json}", "source": []}, {"fact": "x"#;
        let v = parse_json_loose(truncated).unwrap();
        let facts = v["facts"].as_array().unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0]["fact"], "配置格式是 {json}");
    }

    #[test]
    fn parse_json_loose_error_reports_head_and_tail() {
        let long_garbage = "散".repeat(1000);
        let err = parse_json_loose(&long_garbage).unwrap_err().to_string();
        assert!(err.contains("头["), "错误应含头部摘要: {err}");
        assert!(err.contains("尾["), "错误应含尾部摘要: {err}");
    }

    #[test]
    fn parse_json_loose_salvage_ignores_pure_prose() {
        // 纯散文（无 "key": [ 结构）不可抢救
        assert!(parse_json_loose("我认为这些对话没有值得记住的事实。").is_err());
    }
}
