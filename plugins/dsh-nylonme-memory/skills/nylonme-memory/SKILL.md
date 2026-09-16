---
name: nylonme-memory
description: Manual read/write of long-term memory in a self-hosted NylonME engine over its HTTP REST gateway. Use for mid-session operations the automatic DSH plugin does not cover — "remember this fact now" (weave), "recall what we decided about X" (resonate), or "is the memory engine up" (stats). Session-start recall and session-end persistence happen automatically; only use this skill when you need an extra read or write in between.
---

# NylonME Memory (manual)

NylonME is the self-hosted memory engine this DSH profile is wired to. The
`nylonme-memory` plugin already resonates at session start and weaves the
conversation at session end — this skill is only for **extra** reads/writes in
the middle of a session.

## Engine endpoints

All calls are JSON over HTTP. Base URL defaults to `http://127.0.0.1:50052`
(`NYLON_ENGINE_URL`), auth header `x-api-key: <key>` (`NYLON_API_KEY`) only
when the engine has API-key auth enabled.

- `GET  /v1/stats` — health/stats (engine up? node count?)
- `POST /v1/resonate` — recall memories. Body: `{ "owner_id", "query", "tenant_id"?, "budget"? }`
- `POST /v1/weave` — persist one fact. Body: `{ "owner_id", "raw_event", "tenant_id"? }`
- `POST /v1/weave_session` — persist a session transcript. Body: `{ "owner_id", "events": [{ "event_id", "speaker", "text" }], "tenant_id"? }`

`owner_id` is the workspace slug (the plugin derives it automatically; reuse
the same value so manual writes land in the same owner). `event_id` should be
`"<sessionId>:<seq>"` when weaving events so re-sends stay idempotent.

## Workflow

1. **Health (optional)**: `GET /v1/stats`. If it fails, memory is offline —
   say so and continue without retrying in a loop.
2. **Recall**: `POST /v1/resonate` with a short query summarizing what you
   need. Weave the `activated[].filaments.fact` results into your reasoning;
   cite them when they change a decision.
3. **Persist**: after a durable decision/fact/preference, `POST /v1/weave`
   with one self-contained sentence in `raw_event`. Never weave secrets
   (API keys, passwords) or ephemeral state.

## Notes

- Facts are deduplicated by meaning, not text; re-weaving a correction is fine.
- Resonate returns `node_id` + `resonance` + `filaments.fact` ordered by
  resonance score.
- The engine auto-links related memories; no manual edge management needed.
