// LIVE test: the plugin against the REAL NylonME engine at 192.168.1.5.
//
// Uses the real DSH runtime (cordis + dsh-session + dsh-llm) and the real
// engine's HTTP REST gateway + API key. Runs the plugin's two lifecycle hooks
// for real: a real SessionStore session is disposed (→ real /v1/weave_session)
// and a real agent/pre-step waterfall runs (→ real /v1/resonate), then polls
// the engine to prove the memory actually landed and is recallable.
//
// Run:  node test/live.mjs
// Env overrides: NYLON_ENGINE_URL, NYLON_API_KEY, NYLON_TENANT

import { register } from 'node:module';
await register(new URL('./integration-loader.mjs', import.meta.url));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const { createUserMessage, createAssistantMessage } = await import('@deepseek-ai/dsh-llm');
const { apply } = await import('../lib/index.js');

const ENGINE = process.env.NYLON_ENGINE_URL ?? 'http://127.0.0.1:50052';
const API_KEY = process.env.NYLON_API_KEY;
const TENANT = process.env.NYLON_TENANT ?? 'default';

if (!API_KEY) {
  throw new Error('set NYLON_API_KEY to run the live test (optionally NYLON_ENGINE_URL and NYLON_TENANT)');
}
const runId = Date.now();
const owner = 'dsmoke-' + runId;   // derived from the session cwd basename below
const token = 'DSMOKE-LIVE-' + runId;

async function enginePost(path, body) {
  const res = await fetch(ENGINE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}

async function waitFor(fn, timeoutMs = 30000, stepMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

test('LIVE: session dispose → real weave → memory lands in the engine', async () => {
  const root = new Context();
  apply(root, { url: ENGINE, apiKey: API_KEY, tenant: TENANT, weaveMinChars: 1, timeoutMs: 20000 });

  await root.plugin(SessionStore);
  const store = root.sessions;
  // The cwd basename becomes the owner slug (no .git above D:\dsmoke\<owner>).
  const session = store.prepare(SessionId('live-' + runId), { meta: { cwd: 'D:\\dsmoke\\' + owner } });
  const detach = store.enter(session);
  store.announce(session);

  const fact = token + ': the DSH plugin persisted this session to the engine over /v1/weave_session';
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: fact }], source: { kind: 'prompt' } }), { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Confirmed — ' + fact }], source: {} }) }, { surfaceOp: 'append' });

  detach(); // real session/disposed → plugin fires a real /v1/weave_session

  // Poll the engine until the fact is recallable (leaf write is fast; the LLM
  // abstract layer may take a few more seconds).
  const found = await waitFor(async () => {
    try {
      const resp = await enginePost('/v1/resonate', { owner_id: owner, query: token, tenant_id: TENANT, budget: 8 });
      const facts = (resp.activated ?? []).map((a) => a.filaments?.fact ?? '');
      return facts.find((f) => f.includes(token) || f.includes('weave_session')) ? facts : undefined;
    } catch {
      return undefined;
    }
  }, 30000);

  assert.ok(found, 'memory landed and is recallable');
  console.log('  engine recalled:', JSON.stringify(found.slice(0, 4)));
});

test('LIVE: agent/pre-step → real resonate → injects real recalled memories', async () => {
  const root = new Context();
  apply(root, { url: ENGINE, apiKey: API_KEY, tenant: TENANT, timeoutMs: 20000 });

  // Give this owner something to recall (a second, distinctive fact).
  await enginePost('/v1/weave', { owner_id: owner, raw_event: token + ': recall-source fact for the recall test', tenant_id: TENANT, task: 'smoke' });

  const session = { id: 'live-recall-' + runId, header: { cwd: 'D:\\dsmoke\\' + owner } };
  const agent = { session };
  const claimed = [createUserMessage({ content: [{ type: 'text', text: token }], source: { kind: 'prompt' } })];

  // Real waterfall: the plugin's agent/pre-step handler runs a real /v1/resonate.
  const decision = await root.waterfall('agent/pre-step', { agent, messages: claimed, step: 1, signal: undefined }, () => ({ kind: 'enter', messages: [...claimed] }));

  assert.equal(decision.messages.length, 2, 'recall context injected');
  const injected = decision.messages[1].content[0].text;
  assert.match(injected, new RegExp(token), 'injected recall carries the remembered fact');
  console.log('  injected recall text:\n' + injected.slice(0, 600));
});
