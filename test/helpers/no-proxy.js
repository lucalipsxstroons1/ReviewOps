// Import this before `@actions/github` in a test that sends requests.
//
// The library decides while it loads whether to route requests through a
// proxy. Proxy settings of the machine must not apply to tests: every
// request goes to a server on this machine, and a proxy would never reach it.
export const PROXY_VARIABLE = /^(https?|all|no)_proxy$/i;

for (const name of Object.keys(process.env)) {
  if (PROXY_VARIABLE.test(name)) delete process.env[name];
}
