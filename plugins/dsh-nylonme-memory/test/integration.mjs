// Integration test: the plugin against the REAL DSH runtime.
//
// Loads the real @deepseek-ai/cordis + dsh-session + dsh-llm packages, builds a
// real Session in a real SessionStore, appends real user/assistant messages
// (real createUserMessage/createAssistantMessage), disposes the session to emit
// the REAL `session/disposed` event, and asserts the plugin performs a REAL
// HTTP `/v1/weave_session` POST against a real in-process HTTP server.
//
// Run:  node test/integration.mjs
//
// NOTE: the @deepseek-ai/* imports and the plugin import are DYNAMIC (after
// `register()`) because the loader hook must be installed before their
// resolution — static imports link before the module body runs.

import { register } from 'node:module';
await register(new URL('./integration-loader.mjs', import.meta.url));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const { createUserMessage, createAssistantMessage } = await import('@deepseek-ai/dsh-llm');
const { apply, name } = await import('../lib/index.js');

// ── real in-process HTTP engine (stands in for the NylonME Rust gateway) ─────
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
    received.push({ method: req.method, path: req.url, headers: req.headers, body: parsed });

    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url.startsWith('/v1/stats')) return send(200, { nodes: 0, edges: 0 });
    if (req.method === 'POST' && req.url.startsWith('/v1/resonate')) return send(200, { activated: [{ node_id: 7, resonance: 0.9, filaments: { fact: 'remembered fact' } }], seed_ids: [7] });
    if (req.method === 'POST' && req.url.startsWith('/v1/weave_session')) return send(200, { leaf_nodes: [], fact_nodes: [] });
    send(404, { error: 'not found' });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const engineUrl = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('exports the expected plugin name', () => {
  assert.equal(name, 'nylonme-memory');
});

test('real session/disposed drives a real weave over HTTP', async () => {
  received.length = 0;
  const root = new Context();
  {
    apply(root, { url: engineUrl, weaveMinChars: 1, timeoutMs: 2000 });

    await root.plugin(SessionStore);
    const store = root.sessions;
    const session = store.prepare(SessionId('int-session'), { meta: { cwd: 'D:\\work\\nylonme' } });
    const detach = store.enter(session);
    store.announce(session);

    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'We decided to use RocksDB' }], source: { kind: 'prompt' } }), { surfaceOp: 'append' });
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Acknowledged, using RocksDB' }], source: {} }) }, { surfaceOp: 'append' });

    detach(); // emits the real session/disposed event

    await sleep(100); // let the fire-and-forget weave complete

    const weaves = received.filter((r) => r.path.startsWith('/v1/weave_session'));
    assert.equal(weaves.length, 1, 'exactly one weave POST');
    const body = weaves[0].body;
    assert.equal(body.owner_id, 'nylonme', 'owner derived from real header cwd');
    assert.equal(body.tenant_id, 'default');
    assert.equal(body.events.length, 2);
    assert.deepEqual(body.events[0], { event_id: 'int-session:0', speaker: 'user', text: 'We decided to use RocksDB' });
    assert.deepEqual(body.events[1], { event_id: 'int-session:1', speaker: 'assistant', text: 'Acknowledged, using RocksDB' });
  }
});

test('recall handler injects a message when the agent/pre-step waterfall runs', async () => {
  received.length = 0;
  const root = new Context();
  {
    apply(root, { url: engineUrl, timeoutMs: 2000 });
    const session = { id: 'recall-int', header: { cwd: 'D:\\work\\nylonme' } };
    const agent = { session };
    const claimed = [createUserMessage({ content: [{ type: 'text', text: 'Recall what we decided about storage' }], source: { kind: 'prompt' } })];

    const decision = await root.waterfall('agent/pre-step', { agent, messages: claimed, step: 1, signal: undefined }, () => ({ kind: 'enter', messages: [...claimed] }));

    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, 2, 'recall message injected');
    assert.equal(decision.messages[1].source.plugin, 'nylonme-memory');
    assert.match(decision.messages[1].content[0].text, /remembered fact/);

    const resonate = received.filter((r) => r.path.startsWith('/v1/resonate'));
    assert.equal(resonate.length, 1);
    assert.equal(resonate[0].body.owner_id, 'nylonme');
  }
});
