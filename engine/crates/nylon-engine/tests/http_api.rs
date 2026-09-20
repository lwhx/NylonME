//! REST 网关集成测试：与 gRPC 共享同一 EngineService 写路径。
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
#[path = "../src/audit.rs"]
mod audit;

#[path = "../src/auth.rs"]
mod auth;
#[path = "../src/http.rs"]
mod http;
#[path = "../src/mcp.rs"]
mod mcp;
#[path = "../src/service.rs"]
mod service;
use nylon_storage::PersistentGraph;
use serde_json::{json, Value};
use service::EngineService;
use tower::ServiceExt;

fn test_svc(dir: &std::path::Path) -> EngineService {
    let store = PersistentGraph::open(dir).unwrap();
    EngineService::new(store, 8, None, None)
}

async fn call(app: &axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

/// 回答质量回执端点：记录成功 + 落盘持久化 + 参数校验。
#[tokio::test]
async fn rest_feedback_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let app = http::router(test_svc(dir.path()));

    let (s, b) = call(
        &app,
        Request::post("/v1/feedback")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"owner_id": "alice", "query": "Which seat does Alice like?", "rating": "wrong", "comment": "she said window"}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["recorded"], true);
    // 先落盘再入队：feedback.jsonl 立即存在且含该查询
    let log = std::fs::read_to_string(dir.path().join("feedback.jsonl")).unwrap();
    assert!(log.contains("Which seat does Alice like?"));

    // 参数校验：空 query 拒绝
    let (s, _b) = call(
        &app,
        Request::post("/v1/feedback")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"owner_id": "alice", "query": ""}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rest_weave_list_get_resonate_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let app = http::router(test_svc(dir.path()));

    // weave
    let (s, b) = call(
        &app,
        Request::post("/v1/weave")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"owner_id": "alice", "raw_event": "Alice prefers window seats", "task": "travel"}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let node_id = b["node_id"].as_u64().unwrap();

    // list
    let (s, b) = call(
        &app,
        Request::get("/v1/nodes?owner=alice")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["total"].as_u64().unwrap(), 1);
    assert_eq!(b["nodes"][0]["fact"], "Alice prefers window seats");

    // owner filter excludes other tenants' owners
    let (s, b) = call(
        &app,
        Request::get("/v1/nodes?owner=bob")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["total"].as_u64().unwrap(), 0);

    // get_node
    let (s, b) = call(
        &app,
        Request::get(format!("/v1/nodes/{node_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(b["current_tension"].as_f64().unwrap() > 0.0);

    // get_node 404
    let (s, _) = call(
        &app,
        Request::get("/v1/nodes/9999").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // resonate
    let (s, b) = call(
        &app,
        Request::post("/v1/resonate")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"owner_id": "alice", "query": "window seat", "budget": 5}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["activated"].as_array().unwrap().len(), 1);

    // stats
    let (s, b) = call(&app, Request::get("/v1/stats").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["nodes"].as_u64().unwrap(), 1);
    assert_eq!(b["embedder"], false);

    // openapi served
    let (s, b) = call(
        &app,
        Request::get("/openapi.json").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["info"]["title"], "NylonME Memory Engine REST API");

    // ui served
    let resp = app
        .clone()
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("NylonME Console"));
}

#[tokio::test]
async fn rest_weave_validation_error() {
    let dir = tempfile::tempdir().unwrap();
    let app = http::router(test_svc(dir.path()));
    let (s, b) = call(
        &app,
        Request::post("/v1/weave")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"owner_id": "", "raw_event": "x"}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(b["error"].as_str().unwrap().contains("不能为空"));
}

// ---------- /mcp（Streamable HTTP MCP 端点） ----------

/// 发一个 JSON-RPC 请求到 /mcp。json_response=true 时返回纯 JSON；
/// 若服务端回落 SSE（text/event-stream），提取 data: 行解析。
async fn mcp_call(app: &axum::Router, key: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut rb = Request::post("/mcp")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        // rmcp 的 Host 校验要求请求必须带 Host 头（真实 HTTP 客户端都会带，
        // oneshot 测试需要手动补）
        .header("host", "127.0.0.1:50052");
    if let Some(k) = key {
        rb = rb.header("x-api-key", k);
    }
    let resp = app
        .clone()
        .oneshot(rb.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&bytes).to_string();
    let v = serde_json::from_str(&text).unwrap_or_else(|_| {
        let data = text
            .lines()
            .find_map(|l| l.strip_prefix("data: "))
            .unwrap_or("null");
        serde_json::from_str(data).unwrap_or(Value::Null)
    });
    (status, v)
}

fn mcp_initialize() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"}
        }
    })
}

fn mcp_tool_call(id: u64, name: &str, args: Value) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": {"name": name, "arguments": args}
    })
}

#[tokio::test]
async fn mcp_http_open_mode_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let app = http::router(test_svc(dir.path()));

    // initialize：握手拿到服务器信息
    let (s, b) = mcp_call(&app, None, mcp_initialize()).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["result"]["serverInfo"]["name"], "nylonme-memory");

    // tools/call memory_weave
    let (s, b) = mcp_call(
        &app,
        None,
        mcp_tool_call(
            2,
            "memory_weave",
            json!({"fact": "Alice prefers window seats", "owner": "alice"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let text = b["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("NODE_ID="), "{text}");

    // tools/call memory_resonate：刚写入的事实能被召回
    let (s, b) = mcp_call(
        &app,
        None,
        mcp_tool_call(3, "memory_resonate", json!({"query": "window seat", "owner": "alice"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let text = b["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("window seats"), "{text}");
}

#[tokio::test]
async fn mcp_http_auth_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let keys = std::sync::Arc::new(
        auth::ApiKeys::parse(
            r#"[
                {"key": "k-good", "tenant": "default", "scope": "write"},
                {"key": "k-other", "tenant": "other", "scope": "write"},
                {"key": "k-readonly", "tenant": "default", "scope": "read"}
            ]"#,
        )
        .unwrap(),
    );
    let app = http::router(test_svc(dir.path()).with_auth(Some(keys)));

    // 无 key → 401
    let (s, _) = mcp_call(&app, None, mcp_initialize()).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // read 档位不够（端点暴露 weave）→ 403
    let (s, _) = mcp_call(&app, Some("k-readonly"), mcp_initialize()).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // key 的租户不覆盖服务端租户 → 403，且报错带排查指引（P2）
    let (s, b) = mcp_call(&app, Some("k-other"), mcp_initialize()).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let msg = b["error"].as_str().unwrap_or("");
    assert!(msg.contains("无权访问 tenant=default"), "{msg}");
    assert!(msg.contains("/mcp 服务端租户"), "{msg}");

    // 合法 key → 正常握手 + 工具可用
    let (s, b) = mcp_call(&app, Some("k-good"), mcp_initialize()).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let (s, b) = mcp_call(
        &app,
        Some("k-good"),
        mcp_tool_call(2, "memory_weave", json!({"fact": "team fact", "owner": "team"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert!(b["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("NODE_ID="));
}
