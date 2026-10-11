import { createFakeContext } from "./fake-context.js";
import { createFakeCore } from "./fake-core.js";

// A transcript of one run (#114): everything the run does to the outside, in
// the order it does it, across all channels. It is the proof that a rebuild of
// `run()` changes nothing: the transcripts of the fixtures must stay the same.
//
// What is written, one line per event:
//
// - `core.<method>`: every call of the core with its text. Of `setSecret()`
//   only the call is written, never the value. A stack in a debug line is cut
//   to its first line, because line numbers change with every edit.
// - `github`: the requests to GitHub, in the order of the fake client.
// - `model`: the client that is created and every request to it.
// - `insights`: every report that is sent, by kind only (the report itself
//   holds a duration and a random id).
// - `summary`: the text of the job summary as it is written.
//
// The transcript holds no credential: the tests use stand-ins, and the lines
// of `setSecret()` carry no value.

const STACK = /\n\s+at /;

/** One line of a debug message or an error that can hold a stack. */
const withoutStack = (text) => {
  const value = String(text);
  return STACK.test(value) ? `${value.split(STACK)[0]} [stack]` : value;
};

const line = (channel, ...parts) =>
  `${channel} ${parts.map((part) => JSON.stringify(part)).join(" ")}`;

/**
 * A core that writes every call into `events` and passes it on to a fake core.
 * `summary.write()` is recorded as well.
 */
function recordingCore(inputs, events) {
  const inner = createFakeCore(inputs);
  const record = (method) => (text) => {
    events.push(
      method === "setSecret"
        ? "core.setSecret"
        : line(
            `core.${method}`,
            method === "debug" ? withoutStack(text) : text,
          ),
    );
    return inner[method](text);
  };
  const summary = {
    addRaw: (text, addEol) => {
      inner.summary.addRaw(text, addEol);
      return summary;
    },
    write: async () => {
      await inner.summary.write();
      events.push(line("summary", inner.summaries.at(-1)));
      return summary;
    },
  };
  return {
    inner,
    core: {
      getInput: (name) => inner.getInput(name),
      setSecret: record("setSecret"),
      info: record("info"),
      notice: record("notice"),
      warning: record("warning"),
      debug: record("debug"),
      setFailed: record("setFailed"),
      setOutput: (name, value) => {
        events.push(line("core.setOutput", `${name}=${value}`));
        return inner.setOutput(name, value);
      },
      summary,
    },
  };
}

/**
 * Lets a fake client of GitHub write its calls into `events`: the fake keeps
 * them in arrays, so the arrays are made to report each push.
 */
function recordGitHub(octokit, events) {
  const names = new Map([
    [octokit.rest.pulls.listFiles, "listFiles"],
    [octokit.rest.pulls.listReviews, "listReviews"],
    [octokit.rest.pulls.listReviewComments, "listReviewComments"],
  ]);
  const watch = (array, describe) => {
    const push = array.push.bind(array);
    array.push = (item) => {
      events.push(line("github", ...describe(item)));
      return push(item);
    };
  };
  watch(octokit.calls, ({ endpoint, parameters }) => [
    "paginate",
    names.get(endpoint) ?? "unknown",
    parameters,
  ]);
  watch(octokit.comparisons, (parameters) => ["compare", parameters.basehead]);
  watch(octokit.queries, ({ variables }) => ["graphql threads", variables]);
  watch(octokit.viewerQueries, () => ["graphql viewer"]);
  watch(octokit.reviews, (parameters) => ["createReview", parameters]);
  return octokit;
}

/** The paths in the user message of one request. */
const pathsIn = (user) =>
  [...user.matchAll(/^<file path="([^"]*)">$/gm)].map((match) => match[1]);

/**
 * Runs the action with stand-ins and writes the transcript.
 *
 * @param {(deps: object) => Promise<unknown>} run `run()` from `src/main.js`.
 * @param {object} options
 * @param {Record<string, string>} options.inputs
 * @param {object} [options.context] Overrides for `createFakeContext()`.
 * @param {object} options.octokit A fake client from `createFakeOctokit()`.
 * @param {(request: object, index: number) => object | Error} [options.answer]
 *   What the model answers: a result of `complete()` or an error to throw.
 * @param {Function} [options.planBatches]
 * @returns {Promise<{ transcript: string, result: unknown, core: object }>}
 */
export async function recordRun(
  run,
  { inputs, context = {}, octokit, answer, planBatches },
) {
  const events = [];
  const { core, inner } = recordingCore(inputs, events);
  recordGitHub(octokit, events);

  const requests = [];
  const createAiClient = (options) => {
    // The address only when it is not the standard one, so that the runs with
    // the standard address keep their transcripts.
    events.push(
      options.baseUrl && options.baseUrl !== "https://api.openai.com/v1"
        ? line("model", "client", options.model, options.baseUrl)
        : line("model", "client", options.model),
    );
    return {
      async complete(request) {
        const index = requests.length;
        requests.push(request);
        events.push(
          line(
            "model",
            "request",
            `${index}`,
            pathsIn(request.user),
            request.user.length,
          ),
        );
        const reply = answer ? answer(request, index) : { content: "" };
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
  };

  const sendInsightsReport = async (request) => {
    events.push(line("insights", request.kind ?? "review"));
    return { delivered: true, outcome: "stored", httpStatus: 200, attempts: 1 };
  };

  const result = await run({
    core,
    context: createFakeContext({ runId: 1, runAttempt: 1, ...context }),
    getOctokit: () => octokit,
    createAiClient,
    sendInsightsReport,
    ...(planBatches ? { planBatches } : {}),
  });

  return { transcript: `${events.join("\n")}\n`, result, core: inner };
}
