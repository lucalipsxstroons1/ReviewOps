/**
 * Stand-in for `@actions/core` that records every call instead of talking to the runner.
 *
 * @param {Record<string, string>} inputs Input values by name, as a workflow would pass them.
 */
export function createFakeCore(inputs = {}) {
  const calls = [];
  const record =
    (method) =>
    (...args) => {
      calls.push({ method, args });
    };

  return {
    calls,
    getInput: (name) => (inputs[name] ?? "").trim(),
    setSecret: record("setSecret"),
    info: record("info"),
    notice: record("notice"),
    warning: record("warning"),
    debug: record("debug"),
    setFailed: record("setFailed"),
    /** First argument of every call to one method, in order. */
    messages: (method) =>
      calls
        .filter((call) => call.method === method)
        .map((call) => call.args[0]),
  };
}
