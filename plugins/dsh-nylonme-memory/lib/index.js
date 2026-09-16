// @nylonme/dsh-nylonme-memory — DeepSeek Harness plugin.
//
// Mirrors the DSH agent/session lifecycle into a self-hosted NylonME memory
// engine over its HTTP REST gateway:
//
//   session start → POST /v1/resonate      → inject recalled memories as context
//   session end   → POST /v1/weave_session → persist the conversation
//
// Design contract (see README.md):
//   * owner defaults to the workspace slug (git-root or cwd basename), with an
//     explicit config override;
//   * every woven event carries `event_id = "<sessionId>:<seq>"` and the plugin
//     remembers the last woven seq per session, so re-sending the same session
//     (resume across restarts) is idempotent and only appends NEW events.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Cordis plugin name (also the patch row id convention). */
export const name = 'nylonme-memory';

const DEFAULTS = {
  url: 'http://127.0.0.1:50052',
  apiKey: '',
  tenant: 'default',
  owner: '',
  autoRecall: true,
  autoWeave: true,
  recallBudget: 8,
  recallMaxHops: undefined,
  recallQueryMaxChars: 2000,
  recallRenderMaxChars: 4000,
  weaveMinChars: 200,
  weaveMaxEvents: 400,
  weaveSkipAbstract: false,
  weaveSubagents: false,
  timeoutMs: 20000,
  userAgent: 'dsh-nylonme-memory',
};

/**
 * Plugin entry point. Returns void: all registrations below are effect-scoped
 * to this plugin's fiber, so Cordis tears them down in order on unload.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.url) {
    ctx.logger?.warn?.('[nylonme-memory] no engine url configured; plugin is inactive');
    return;
  }

  // Per-session recall state; sessions are keyed weakly so a disposed session
  // (and its state) is garbage-collected with the plugin's own lifecycle.
  const recallState = new WeakMap();
  // Last successfully woven seq per session id, seeded from the durable marker.
  const lastWovenSeq = loadWovenMarker();
  // Sessions with an in-flight weave (a session disposes once, but guard anyway).
  const weaving = new Set();

  // Best-effort startup probe so a misconfigured engine URL fails loudly once
  // instead of silently skipping recall/weave for every session.
  void healthProbe(config).then((ok) => {
    if (ok) ctx.logger?.info?.('[nylonme-memory] engine reachable at %s', config.url);
    else ctx.logger?.warn?.('[nylonme-memory] engine unreachable at %s — recall/weave will be skipped', config.url);
  });

  // ── session start: resonate → inject recalled context ─────────────────────
  if (config.autoRecall) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || step !== 1) return decision;

      const session = agent.session;
      let state = recallState.get(session);
      if (!state) {
        state = { done: false };
        recallState.set(session, state);
      }
      if (state.done) return decision;
      state.done = true;

      const query = messagesText(messages, config.recallQueryMaxChars);
      if (!query) return decision;

      const desired = await recallMessage(session, query, config, signal).catch((error) => {
        ctx.logger?.warn?.('[nylonme-memory] recall failed: %o', error);
        return undefined;
      });
      if (!desired) return decision;

      const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message));
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimed + 1, 0, desired) };
    });
  }

  // ── session end: weave the conversation (incremental + idempotent) ────────
  if (config.autoWeave) {
    ctx.on('session/disposed', (session) => {
      if (!config.weaveSubagents && isSubagent(session)) return;
      if (weaving.has(session.id)) return;

      const fromSeq = (lastWovenSeq.get(session.id) ?? -1) + 1;
      const events = collectSessionEvents(session, fromSeq, config.weaveMaxEvents);
      if (events.length === 0) return;
      if (events.reduce((n, e) => n + e.text.length, 0) < config.weaveMinChars) return;

      weaving.add(session.id);
      weaveSession(session, events, config)
        .then(() => {
          const lastSeq = events[events.length - 1].seq;
          lastWovenSeq.set(session.id, lastSeq);
          recordWoven(session.id, lastSeq);
        })
        .catch((error) => ctx.logger?.warn?.('[nylonme-memory] weave failed: %o', error))
        .finally(() => weaving.delete(session.id));
    });
  }
}

// ── config ──────────────────────────────────────────────────────────────────

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) };
  config.url = String(config.url ?? '').trim().replace(/\/+$/, '');
  config.tenant = String(config.tenant ?? DEFAULTS.tenant) || DEFAULTS.tenant;
  config.owner = String(config.owner ?? '').trim();
  config.apiKey = String(config.apiKey ?? '').trim();
  config.autoRecall = config.autoRecall !== false;
  config.autoWeave = config.autoWeave !== false;
  config.recallBudget = toInt(config.recallBudget, 8);
  config.recallQueryMaxChars = toInt(config.recallQueryMaxChars, 2000);
  config.recallRenderMaxChars = toInt(config.recallRenderMaxChars, 4000);
  config.weaveMinChars = toInt(config.weaveMinChars, 200);
  config.weaveMaxEvents = toInt(config.weaveMaxEvents, 400);
  config.timeoutMs = toInt(config.timeoutMs, 20000);
  config.weaveSubagents = config.weaveSubagents === true;
  config.weaveSkipAbstract = config.weaveSkipAbstract === true;
  if (config.recallMaxHops != null) config.recallMaxHops = toInt(config.recallMaxHops, undefined);
  return config;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// ── owner derivation ────────────────────────────────────────────────────────

/** Resolve the NylonME owner: explicit config, else the workspace slug. */
function ownerFor(session, config) {
  if (config.owner) return config.owner;
  const cwd = session?.header?.cwd ?? process.cwd();
  const root = findRepoRoot(cwd) ?? cwd;
  return slugify(basename(root)) || 'default';
}

/** Walk up from `start` to the first directory containing a `.git` entry. */
function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── message helpers ─────────────────────────────────────────────────────────

/** Concatenate the text blocks of a message list into one query string. */
function messagesText(messages, maxChars) {
  const text = (messages ?? []).map(messageText).filter(Boolean).join('\n').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Extract the plain-text content of an LLM message (user or assistant). */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

// ── recall (resonate) ───────────────────────────────────────────────────────

async function recallMessage(session, query, config, signal) {
  const body = {
    owner_id: ownerFor(session, config),
    query,
    tenant_id: config.tenant,
    budget: config.recallBudget,
  };
  if (config.recallMaxHops != null) body.max_hops = config.recallMaxHops;

  const data = await fetchJson(config.url, '/v1/resonate', body, config, signal);
  const activated = Array.isArray(data?.activated) ? data.activated : [];
  if (activated.length === 0) return undefined;

  const text = renderRecall(activated, config.recallRenderMaxChars);
  if (!text) return undefined;

  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  });
}

function renderRecall(activated, maxChars) {
  const lines = activated
    .map((a) => `- (${a?.resonance?.toFixed?.(3) ?? '?'}) ${a?.filaments?.fact ?? ''}`)
    .map((line) => line.trim())
    .filter((line) => line.length > 2);
  if (lines.length === 0) return '';
  const text = 'Relevant memories recalled by NylonME (context only — verify before relying on them):\n' + lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

// ── weave ───────────────────────────────────────────────────────────────────

function isSubagent(session) {
  return session?.header?.origin === 'subagent' || (session?.header?.delegationDepth ?? 0) > 0;
}

/**
 * Collect surface messages (user + assistant) with seq >= fromSeq, bounded to
 * the most recent `maxEvents`. `event_id` is the stable idempotency key.
 */
function collectSessionEvents(session, fromSeq, maxEvents) {
  const out = [];
  for (const event of session.events) {
    if (event.seq < fromSeq) continue;
    if (event.type === 'user/message') {
      const text = messageText(event.data);
      if (text) out.push({ seq: event.seq, event_id: `${session.id}:${event.seq}`, speaker: 'user', text });
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text) out.push({ seq: event.seq, event_id: `${session.id}:${event.seq}`, speaker: 'assistant', text });
    }
  }
  return out.slice(-maxEvents);
}

async function weaveSession(session, events, config) {
  const body = {
    owner_id: ownerFor(session, config),
    tenant_id: config.tenant,
    events: events.map(({ event_id, speaker, text }) => ({ event_id, speaker, text })),
    skip_abstract: config.weaveSkipAbstract,
  };
  return fetchJson(config.url, '/v1/weave_session', body, config);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function fetchJson(baseUrl, path, body, config, signal) {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const control = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'user-agent': config.userAgent,
    },
    body: JSON.stringify(body),
    signal: control,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`nylonme ${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.json();
}

async function healthProbe(config) {
  try {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const response = await fetch(config.url + '/v1/stats', {
      method: 'GET',
      headers: {
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        'user-agent': config.userAgent,
      },
      signal: timeout,
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── idempotency marker (best-effort, append-only) ───────────────────────────

function markerPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'nylonme-memory', 'woven.jsonl');
}

/** Load the last-woven seq per session id (max wins across duplicate lines). */
function loadWovenMarker() {
  const map = new Map();
  try {
    const raw = readFileSync(markerPath(), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record.sessionId === 'string' && Number.isSafeInteger(record.lastSeq)) {
          const previous = map.get(record.sessionId);
          if (previous === undefined || record.lastSeq > previous) map.set(record.sessionId, record.lastSeq);
        }
      } catch {
        /* ignore a torn/partial line */
      }
    }
  } catch {
    /* first run: no marker file */
  }
  return map;
}

function recordWoven(sessionId, lastSeq) {
  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    appendFileSync(markerPath(), JSON.stringify({ sessionId, lastSeq, at: new Date().toISOString() }) + '\n');
  } catch {
    /* best-effort: in-memory idempotency still holds for this process */
  }
}
