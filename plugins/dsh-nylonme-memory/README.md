# @nylonme/dsh-nylonme-memory

DeepSeek Harness（DSH）插件：把 DSH 的会话生命周期自动镜像到自建的 NylonME 记忆引擎，
让每个 DSH 会话「开箱即用」地有长期记忆——会话开始自动共振回忆、会话结束自动编织入库。

这是把 Codex 同款插件 `nylonme-memory` 改造成 DSH 插件后的形态：不再依赖
「拷脚本 + plink + 配环境变量」，而是作为 DSH 的 bundle 装进 profile，
配置只剩环境变量，零二进制。

## 它做了什么

| 时机 | DSH 生命周期钩子 | NylonME 动作 | 结果 |
|---|---|---|---|
| 会话开始 | `agent/pre-step`（step 1） | `POST /v1/resonate` | 把召回的记忆作为一段 user 上下文注入首条消息前 |
| 会话结束 | `session/disposed` | `POST /v1/weave_session` | 把整段 user/assistant 对话写入引擎 |
| owner 归属 | `session.header.cwd` | — | 自动取 workspace slug（git 根目录 basename，退化为 cwd basename） |
| 幂等 | 事件 `seq` | `event_id = "<sessionId>:<seq>"` | 记录每会话 last-woven seq，重发/续接只追加新事件 |

对应之前产品化建议里的「路径 D：DSH 插件包」四条动作，全部落地：
session/end 自动 WeaveSession、会话开始自动 Resonate 注入 prompt section、
owner 自动取 workspace slug、session id + seq 做幂等。

## 前置条件

插件本身零二进制，但需要一台跑着 **NylonME 引擎 HTTP REST 网关**的机器
（引擎自带，默认 `http://127.0.0.1:50052`，`NYLON_HTTP_ADDR` 可改、`off` 关闭）：

```bash
# 引擎侧（已有部署可跳过）
NYLON_DATA_DIR=./data \
NYLON_EMBED_URL=http://localhost:11434 NYLON_EMBED_MODEL=bge-m3 NYLON_EMBED_DIMS=1024 \
nylon-engine serve 0.0.0.0:50051
```

开了 API key 鉴权（`NYLON_API_KEYS_FILE`）时，给插件一把 `write` 档位的 key：
`nylon-engine keys add --tenant default --scope write`。

## 安装

把本目录发布成 npm 包（或直接以本地路径/ tarball 安装），然后：

```bash
# 以本地路径安装（发布后换成 @nylonme/dsh-nylonme-memory）
dsh plugin --profile web add file:D:/path/to/nylon/plugins/dsh-nylonme-memory
```

`dsh plugin` 会把它装进 profile 的 `node_modules`，并因包内声明了
`dsh.bundle` 自动加进 `dsh.profile.bundles`——装上即生效，重启 DSH web 即可。

## 配置

默认从环境变量读取（同一份安装在不同机器上用不同引擎）：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `NYLON_ENGINE_URL` | `http://127.0.0.1:50052` | 引擎 HTTP REST 基址 |
| `NYLON_API_KEY` | 空 | 引擎 API key（`x-api-key` 头），鉴权模式必填 |
| `NYLON_TENANT` | `default` | 租户 |
| `NYLON_OWNER` | 空 | owner 显式覆盖；空 = 自动取 workspace slug |

也可以把本包 `cordis.patch.yml` 里的这一行复制到 profile 自己的
`cordis.patch.yml`（按 id `nylonme-memory` 覆盖），把 `!!js` 表达式换成静态值。
完整配置项见 `lib/index.d.ts` 的 `NylonmeMemoryConfig`。

## 幂等怎么保证的

- 每个事件带 `event_id = "<sessionId>:<seq>"`，重发时身份稳定；
- 插件在 `$DSH_HOME/storages/nylonme-memory/woven.jsonl` 里按会话记
  `lastSeq`（追加写、best-effort）。会话被 resume 后再次结束，只编织
  `seq > lastSeq` 的新事件，老事件不重复入库；
- 进程内还有一层 Set 防重入。引擎侧 `weave_session` 目前不按 `event_id`
  去重（中途失败重试会产生少量重复叶节点，见 `tests/locomo_eval.rs`），所以
  幂等由插件这一层负责——这正是本插件写 `event_id` 并把 lastSeq 落盘的原因。

## 可选：手动 skill

`skills/nylonme-memory/SKILL.md` 提供会话中途的**手动**读写（"现在记住这个"、
"查一下我们关于 X 的决定"），与自动钩子互补。要用它，把
`dsh-skill-filesystem` 的扫描目录指向 `skills/`（或在 `$DSH_HOME/skills`
放一份）。不用也不影响自动记忆。

## 测试

三层测试，从纯 mock 到真实引擎逐层递进（均从仓库 checkout 运行）：

| 命令 | 真实度 | 说明 |
|---|---|---|
| `npm test` | 全 mock | mock fetch + mock `@deepseek-ai/dsh-llm` + 假 ctx，驱动两条钩子断言 HTTP 请求 |
| `npm run test:integration` | 真实运行时 | 真实 cordis + dsh-session + dsh-llm，真实 `session/disposed` 与 `agent/pre-step` 瀑布，打到进程内 mock 引擎 |
| `npm run test:live` | 端到端 | 上面基础上，真的打到 NylonME 引擎：dispose → 真实 `/v1/weave_session` 落库，瀑布 → 真实 `/v1/resonate` 召回并注入 |

`test:live` 需要指向一台真实引擎（用你自己的 key，别提交进仓库）：

```bash
NYLON_ENGINE_URL=http://192.168.1.5:50052 \
NYLON_API_KEY=nyl_xxx node test/live.mjs
```

覆盖：插件名与钩子注册、step 1 共振注入、后续 step 不重复注入、
weave 的 `sessionId:seq` 事件身份、跨重启幂等（marker 文件）、子会话/过短会话跳过、
以及真实引擎上的「落库后可召回」。


## 目录结构

```
dsh-nylonme-memory/
├── package.json          # bundle 声明（dsh.bundle.patch）+ ESM + peer deps
├── cordis.patch.yml      # 插件行：id=nylonme-memory，配置走环境变量
├── lib/
│   ├── index.js          # apply(ctx, config)：recall + weave 两条生命周期钩子
│   └── index.d.ts        # 配置类型
├── skills/nylonme-memory/SKILL.md   # 可选手动 skill
└── README.md
```

## 注意 / 待办

- 包名 `@nylonme/dsh-nylonme-memory` 的 scope 是占位，发布前换成你自己的 npm org。
- `weave_session` 的抽象层（session 级 LLM 事实）需要引擎配了 `NYLON_LLM_*`；
  未配时叶子层（逐事件原文）仍可用，只是不做事实抽取。
- 并发多人写同一 owner 时，引擎侧的容量与限流按产品化建议「单引擎容量与限流」
  单独评估，本插件只做单会话的失败重试边界（失败即跳过 + 日志，不阻塞会话）。