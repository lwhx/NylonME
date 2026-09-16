// Smoke test for @nylonme/dsh-nylonme-memory.
//
// Runs without a real NylonME engine and without a DSH profile: it registers an
// ESM loader that mocks `@deepseek-ai/dsh-llm`, mocks global `fetch` to a
// scripted engine, builds a minimal fake Cordis `ctx`, then drives the plugin's
// two lifecycle hooks and asserts on the HTTP calls they produce.
//
// Run:  node test/smoke.mjs        (or: npm test)

import { register } from 'node:module';
await register(new URL('./loader.mjs', import.meta.url));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, name } = await import('../lib/index.js');

// ── scripted engine (in place of a real NylonME HTTP gateway) ────────────────
const requests = []; // { method, path, headers, body }

function resetRequests() {
  requests.length = 0;
}

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const path = new URL(url).pathname;
  let body;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  requests.push({ method, path, headers: init.headers ?? {}, body });

  const json = (value) => ({ ok: true, status: 200, json: async () => value });
  if (method === 'GET' && path === '/v1/stats') return json({ nodes: 3, edges: 5 });
  if (method === 'POST' && path === '/v1/resonate') {
    return json({ activated: [{ node_id: 1, resonance: 0.9, filaments: { fact: 'NylonME remembered: build the DSH plugin' } }], seed_ids: [1] });
  }
  if (method === 'POST' && path === '/v1/weave_session') {
    return json({ leaf_nodes: [], fact_nodes: [] });
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

// ── fake Cordis ctx ──────────────────────────────────────────────────────────
function makeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

function makeSession({ id, cwd = 'D:\\work\\nylonme', seq = 0, events = [], origin, delegationDepth } = {}) {
  return {
    id,
    seq,
    events,
    header: {
      cwd,
      ...(origin ? { origin } : {}),
      ...(delegationDepth != null ? { delegationDepth } : {}),
    },
  };
}

const userMsg = (text) => ({ id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'prompt' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = { url: 'http://engine.test', timeoutMs: 200 };

let tempHome;

test.before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'nylonme-smoke-'));
  process.env.DSH_HOME = tempHome;
});

test.after(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

test('exports plugin name and registers both lifecycle hooks', () => {
  assert.equal(name, 'nylonme-memory');
  const ctx = makeCtx();
  apply(ctx, { ...BASE });
  assert.ok(ctx.listeners.get('agent/pre-step')?.length === 1, 'agent/pre-step registered');
  assert.ok(ctx.listeners.get('session/disposed')?.length === 1, 'session/disposed registered');
});

test('recall: resonates once at step 1 and injects a context message', async () => {
  resetRequests();
  const ctx = makeCtx();
  apply(ctx, { ...BASE, recallBudget: 8 });
  const preStep = ctx.listeners.get('agent/pre-step')[0];

  const session = makeSession({ id: 'recall-1', cwd: 'D:\\work\\nylonme' });
  const agent = { session };
  const claimed = [userMsg('Help me build a DSH plugin')];

  const decision = await preStep(
    { agent, messages: claimed, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [...claimed] }),
  );

  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, 'claimed + injected recall');
  const injected = decision.messages[1];
  assert.equal(injected.source.plugin, 'nylonme-memory');
  assert.match(injected.content[0].text, /NylonME remembered/);

  const resonate = requests.filter((r) => r.path === '/v1/resonate');
  assert.equal(resonate.length, 1);
  assert.equal(resonate[0].body.owner_id, 'nylonme', 'owner derived from workspace slug');
  assert.equal(resonate[0].body.query, 'Help me build a DSH plugin');
  assert.equal(resonate[0].body.tenant_id, 'default');
  assert.equal(resonate[0].body.budget, 8);
});

test('recall: does not re-inject on later steps', async () => {
  resetRequests();
  const ctx = makeCtx();
  apply(ctx, { ...BASE });
  const preStep = ctx.listeners.get('agent/pre-step')[0];

  const session = makeSession({ id: 'recall-2' });
  const agent = { session };
  const claimed = [userMsg('Do the next thing')];

  // step 1 warms the per-session "done" flag
  await preStep({ agent, messages: claimed, step: 1, signal: undefined }, async () => ({ kind: 'enter', messages: [...claimed] }));
  const firstResonate = requests.filter((r) => r.path === '/v1/resonate').length;

  const decision = await preStep({ agent, messages: claimed, step: 2, signal: undefined }, async () => ({ kind: 'enter', messages: [...claimed] }));
  assert.equal(decision.messages.length, 1, 'no extra injection on step 2');
  assert.equal(requests.filter((r) => r.path === '/v1/resonate').length, firstResonate);
});

test('weave: persists user+assistant messages with sessionId:seq event ids', async () => {
  resetRequests();
  const ctx = makeCtx();
  apply(ctx, { ...BASE, weaveMinChars: 1 });
  const disposed = ctx.listeners.get('session/disposed')[0];

  const session = makeSession({
    id: 'weave-1',
    seq: 2,
    events: [
      { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'We decided to use RocksDB' }] } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'Acknowledged, using RocksDB' }] } } },
    ],
  });

  disposed(session);
  await sleep(50);

  const weaves = requests.filter((r) => r.path === '/v1/weave_session');
  assert.equal(weaves.length, 1);
  const body = weaves[0].body;
  assert.equal(body.owner_id, 'nylonme');
  assert.equal(body.tenant_id, 'default');
  assert.equal(body.events.length, 2);
  assert.deepEqual(body.events[0], { event_id: 'weave-1:0', speaker: 'user', text: 'We decided to use RocksDB' });
  assert.deepEqual(body.events[1], { event_id: 'weave-1:1', speaker: 'assistant', text: 'Acknowledged, using RocksDB' });
});

test('weave: idempotent across restart via the marker file', async () => {
  resetRequests();
  const config = { ...BASE, weaveMinChars: 1 };
  const session = makeSession({
    id: 'idem-1',
    seq: 1,
    events: [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'first durable fact' }] } }],
  });

  // first "process"
  let ctx = makeCtx();
  apply(ctx, config);
  ctx.listeners.get('session/disposed')[0](session);
  await sleep(50);
  assert.equal(requests.filter((r) => r.path === '/v1/weave_session').length, 1);

  // second "process": fresh ctx + fresh apply re-reads the marker file
  ctx = makeCtx();
  apply(ctx, config);
  ctx.listeners.get('session/disposed')[0](session);
  await sleep(50);
  assert.equal(requests.filter((r) => r.path === '/v1/weave_session').length, 1, 'already-woven events are not re-sent');
});

test('weave: skips subagent sessions unless configured, and skips tiny sessions', async () => {
  resetRequests();
  const sub = makeSession({
    id: 'sub-1',
    origin: 'subagent',
    seq: 1,
    events: [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'child work worth remembering' }] } }],
  });

  // default: subagents skipped
  let ctx = makeCtx();
  apply(ctx, { ...BASE, weaveMinChars: 1 });
  ctx.listeners.get('session/disposed')[0](sub);
  await sleep(50);
  assert.equal(requests.filter((r) => r.path === '/v1/weave_session').length, 0);

  // opt-in: subagents woven
  resetRequests();
  ctx = makeCtx();
  apply(ctx, { ...BASE, weaveMinChars: 1, weaveSubagents: true });
  ctx.listeners.get('session/disposed')[0](sub);
  await sleep(50);
  assert.equal(requests.filter((r) => r.path === '/v1/weave_session').length, 1);

  // tiny session (below weaveMinChars) skipped
  resetRequests();
  const tiny = makeSession({
    id: 'tiny-1',
    seq: 1,
    events: [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'ok' }] } }],
  });
  ctx = makeCtx();
  apply(ctx, { ...BASE, weaveMinChars: 10000 });
  ctx.listeners.get('session/disposed')[0](tiny);
  await sleep(50);
  assert.equal(requests.filter((r) => r.path === '/v1/weave_session').length, 0);
});
