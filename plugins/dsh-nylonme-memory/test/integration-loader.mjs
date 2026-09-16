// ESM loader hook for the integration test: resolves every `@deepseek-ai/*`
// specifier against the REAL DSH profile node_modules
// (C:/Users/MyDong/.dsh/profiles/node_modules), so the test exercises the
// plugin against the actual Cordis + dsh-session + dsh-llm runtime instead of
// mocks. Re-parenting to the profile root lets Node's own exports-map
// resolution pick the right entry for the whole transitive graph.
const PROFILE = 'file:///C:/Users/MyDong/.dsh/profiles/';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: PROFILE + '__root__.mjs' });
  }
  return nextResolve(specifier, context);
}
