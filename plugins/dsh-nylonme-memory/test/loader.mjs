// ESM loader hook used only by the smoke test: short-circuits the plugin's
// `@deepseek-ai/dsh-llm` import to a tiny local mock so the test needs no
// profile node_modules and never touches a real NylonME engine.
const MOCK = [
  "export const createUserMessage = (input) => ({ id: 'mock-msg', role: 'user', ...input });",
  "",
].join("\n");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: 'mock://dsh-llm', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'mock://dsh-llm') {
    return { format: 'module', source: MOCK, shortCircuit: true };
  }
  return nextLoad(url, context);
}
