/**
 * Stand-in for `@actions/core` that records every call instead of talking to the runner.
 *
 * @param {Record<string, string>} inputs Input values by name, as a workflow would pass them.
 * @param {object} [options]
 * @param {Error} [options.summaryError] Thrown when the job summary is
 *   written, like the runner does without a summary file.
 */
export function createFakeCore(inputs = {}, { summaryError } = {}) {
  const calls = [];
  const outputs = {};
  const summaries = [];
  const record =
    (method) =>
    (...args) => {
      calls.push({ method, args });
    };

  // The part of `core.summary` the action uses: text is collected with
  // addRaw() and written at once. `summaries` holds every written text.
  let buffer = "";
  const summary = {
    addRaw(text, addEol = false) {
      buffer += addEol ? `${text}\n` : text;
      return summary;
    },
    async write() {
      if (summaryError) throw summaryError;
      summaries.push(buffer);
      buffer = "";
      return summary;
    },
  };

  return {
    calls,
    outputs,
    summaries,
    summary,
    setOutput: (name, value) => {
      calls.push({ method: "setOutput", args: [name, value] });
      outputs[name] = value;
    },
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
