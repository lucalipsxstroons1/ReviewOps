// The parts of the model comparison (#80) that can be tested without a
// network: the list of cases, a client for GitHub that cannot write, a core
// that records what the action says, a counter for the requests to the model,
// and the formatting of the results.
//
// The comparison runs the code of the action. Nothing here filters files,
// masks secrets, applies limits, plans requests or selects findings: that is
// `run()` from src/main.js, called with these stand-ins. The one place where
// the comparison differs from a real run is the history of the pull request:
// every run is a first, complete review (see `createReadOnlyOctokit()`).

import { readFileSync } from "node:fs";
import { AiError } from "../../src/ai/error.js";
import { CATEGORIES, SEVERITIES } from "../../src/ai/schema.js";
import { printable } from "../../src/printable.js";

export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 5;

// --- The list of cases -------------------------------------------------------

const CASE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PULL_REQUEST = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]{0,8})$/;
const MAX_DESCRIPTION = 300;
// Control characters, including line breaks, and code fences have no place in
// a list of cases: it describes defects and does not hold code.
const CONTROL = /\p{Cc}/u;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks the list of cases. The format:
 *
 *     { "cases": [{
 *       "id": "react-hook-demo",             unique, kebab-case
 *       "pr": "owner/repo#62",               a pull request that was merged
 *       "focus": "react",                    one of the categories
 *       "defects": [{                        the defects that are documented;
 *                                            an empty list measures false alarms
 *         "path": "src/OrderList.jsx",       the file of the defect
 *         "description": "…",                one line, no code
 *         "evidence": "https://…"            where the defect is documented
 *       }]
 *     }] }
 *
 * @param {unknown} data The parsed file.
 * @returns {{ id: string, pr: string, focus: string, defects: object[] }[]}
 * @throws {Error} Names the place and the rule, never the value.
 */
export function validateCases(data) {
  const fail = (place, rule) => {
    throw new Error(`The list of cases is invalid at ${place}: ${rule}.`);
  };
  const exactly = (value, keys, place) => {
    if (!isObject(value)) fail(place, "must be an object");
    if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
      fail(place, `must have exactly the fields ${keys.join(", ")}`);
    }
  };

  exactly(data, ["cases"], "the file");
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    fail("cases", "must be a list with at least one case");
  }

  const ids = new Set();
  data.cases.forEach((entry, index) => {
    const place = `cases[${index}]`;
    exactly(entry, ["id", "pr", "focus", "defects"], place);
    if (typeof entry.id !== "string" || !CASE_ID.test(entry.id)) {
      fail(`${place}.id`, "must be kebab-case");
    }
    if (ids.has(entry.id)) fail(`${place}.id`, "must be unique");
    ids.add(entry.id);
    if (typeof entry.pr !== "string" || !PULL_REQUEST.test(entry.pr)) {
      fail(`${place}.pr`, "must be owner/repo#number");
    }
    if (!CATEGORIES.includes(entry.focus)) {
      fail(`${place}.focus`, `must be one of ${CATEGORIES.join(", ")}`);
    }
    // An empty list is a pull request without a documented defect: a run on
    // it measures false alarms.
    if (!Array.isArray(entry.defects)) {
      fail(`${place}.defects`, "must be a list of defects");
    }
    entry.defects.forEach((defect, at) => {
      const where = `${place}.defects[${at}]`;
      exactly(defect, ["path", "description", "evidence"], where);
      if (
        typeof defect.path !== "string" ||
        defect.path === "" ||
        CONTROL.test(defect.path)
      ) {
        fail(`${where}.path`, "must be a path");
      }
      if (
        typeof defect.description !== "string" ||
        defect.description === "" ||
        defect.description.length > MAX_DESCRIPTION ||
        CONTROL.test(defect.description) ||
        defect.description.includes("```")
      ) {
        fail(
          `${where}.description`,
          `must be one line of at most ${MAX_DESCRIPTION} characters without code`,
        );
      }
      if (
        typeof defect.evidence !== "string" ||
        !defect.evidence.startsWith("https://") ||
        CONTROL.test(defect.evidence)
      ) {
        fail(`${where}.evidence`, "must be a link that starts with https://");
      }
    });
  });
  return data.cases;
}

/** Reads and checks the list of cases in a file. */
export function loadCases(file) {
  return validateCases(JSON.parse(readFileSync(file, "utf8")));
}

/** Splits `owner/repo#number`, which `validateCases()` has checked. */
export function parsePullRequestRef(ref) {
  const [, owner, repo, number] = PULL_REQUEST.exec(ref);
  return { owner, repo, number: Number(number) };
}

/** The number of runs per case: 1 to 5, 3 without a value. */
export function parseRuns(value) {
  const text = (value ?? "").trim();
  if (text === "") return DEFAULT_RUNS;
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > MAX_RUNS) {
    throw new Error(
      `The number of runs must be a whole number from 1 to ${MAX_RUNS}.`,
    );
  }
  return Number(text);
}

// --- A client for GitHub that cannot write -----------------------------------

// The reviews and the review comments that ReviewOps left earlier on the
// pull request. The comparison answers both with empty lists: pull requests
// of this repository carry reviews of ReviewOps already, and the action would
// then review only what is new, or nothing. Every run is a first, complete
// review instead.
const HISTORY = /\/pulls\/[^/]+\/(reviews|comments)$/;
const REVIEW = /\/pulls\/[^/]+\/reviews$/;

/**
 * Puts a guard on an Octokit client: reads go through, the one request that
 * posts a review is recorded and answered as if it had worked, and every
 * other request fails. Nothing is ever written to GitHub.
 *
 * @param {import("@octokit/core").Octokit} octokit From `getOctokit()`.
 * @returns {{ octokit: object, posted: { body: string, comments: object[] }[] }}
 *   `posted` holds what the action would have posted.
 */
export function createReadOnlyOctokit(octokit) {
  const posted = [];
  octokit.hook.wrap("request", async (request, options) => {
    const method = String(options.method).toUpperCase();
    const url = String(options.url).split("?")[0];

    if (method === "GET" && HISTORY.test(url)) {
      return { status: 200, url, headers: {}, data: [] };
    }
    if (method === "POST" && REVIEW.test(url)) {
      // Only the parts of the request that hold the review. The headers carry
      // the token and are never copied.
      posted.push({
        body: typeof options.body === "string" ? options.body : "",
        comments: Array.isArray(options.comments) ? options.comments : [],
      });
      return { status: 200, url, headers: {}, data: { id: 1 } };
    }
    if (method === "GET") return request(options);
    throw new Error(
      `The comparison blocked a request that is not a read: ${method} ${url}`,
    );
  });
  return { octokit, posted };
}

/**
 * The context the action gets from the runner on a `pull_request` event, built
 * from the pull request as GitHub returns it.
 */
export function buildContext({ owner, repo, pull }) {
  return {
    eventName: "pull_request",
    repo: { owner, repo },
    payload: { pull_request: pull },
    actor: "",
  };
}

// --- A core that records what the action says --------------------------------

/**
 * The part of `@actions/core` that `run()` uses, for one run of one case.
 * Inputs come from `inputs`. Log lines, notices and warnings go on to the
 * real core with the name of the case in front: the action writes them under
 * the rules of its own log, so they hold no code and no key. A failure and
 * the job summary are only recorded: one failed run must not fail the
 * workflow before the other results are out.
 *
 * @param {object} options
 * @param {typeof import("@actions/core")} options.real
 * @param {string} options.label Names the case and the run, from the list of
 *   cases and from counting.
 * @param {Record<string, string>} options.inputs
 */
export function createRecordingCore({ real, label, inputs }) {
  const record = {
    info: [],
    notices: [],
    warnings: [],
    failures: [],
    summaries: [],
    outputs: {},
  };
  const tagged = (message) => `[${label}] ${message}`;
  const core = {
    getInput: (name) => inputs[name] ?? "",
    setSecret: (secret) => real.setSecret(secret),
    info(message) {
      record.info.push(message);
      real.info(tagged(message));
    },
    notice(message) {
      record.notices.push(message);
      real.notice(tagged(message));
    },
    warning(message) {
      record.warnings.push(message);
      real.warning(tagged(message));
    },
    debug: (message) => real.debug(tagged(message)),
    setFailed: (message) => record.failures.push(String(message)),
    setOutput: (name, value) => {
      record.outputs[name] = value;
    },
    summary: {
      addRaw(text) {
        return {
          async write() {
            record.summaries.push(text);
          },
        };
      },
    },
  };
  return { core, record };
}

// --- A counter for the requests to the model ---------------------------------

/**
 * Wraps `createAiClient()` so that the comparison can count the requests, the
 * tokens and the kinds of failure. Prompt and answer pass through untouched
 * and are never looked at. The SDK repeats a request after a 429 on its own;
 * only a 429 that stays is counted.
 *
 * @param {typeof import("../../src/ai/client.js").createAiClient} createAiClient
 */
export function createCountingClient(createAiClient) {
  const stats = {
    calls: 0,
    withoutUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    failed: {},
  };
  const create = (options) => {
    const client = createAiClient(options);
    return {
      async complete(prompt) {
        stats.calls += 1;
        try {
          const answer = await client.complete(prompt);
          if (answer.usage) {
            stats.inputTokens += answer.usage.inputTokens;
            stats.outputTokens += answer.usage.outputTokens;
            stats.totalTokens += answer.usage.totalTokens;
          } else {
            stats.withoutUsage += 1;
          }
          return answer;
        } catch (error) {
          const kind = error instanceof AiError ? error.kind : "defect";
          stats.failed[kind] = (stats.failed[kind] ?? 0) + 1;
          throw error;
        }
      },
    };
  };
  return { create, stats };
}

// --- What the log of the action says -----------------------------------------

const lineOf = (lines, pattern) => {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match;
  }
  return null;
};

/**
 * Reads the numbers out of the log of the action. They stand in lines of
 * `run()`; a test fails as soon as one of the wordings changes.
 *
 * @param {{ info: string[], warnings: string[] }} record
 */
export function readNumbers({ info, warnings }) {
  const count = (lines, pattern) => Number(lineOf(lines, pattern)?.[1] ?? 0);
  const finished = lineOf(
    info,
    /^Review finished: \d+ findings \((\d+) critical, (\d+) major, (\d+) minor, (\d+) info\)/,
  );
  return {
    // Files over `max-files` or `max-diff-chars`, and files larger than one
    // request: not reviewed, and named in the log of the action.
    skippedByLimits:
      count(warnings, /^Files left out because of the limits: (\d+)\./) +
      count(warnings, /^Files larger than one request to the model: (\d+)\./),
    overMaxComments: count(
      info,
      /(\d+) over the limit of \d+ \(max-comments\)\./,
    ),
    failedRequests: count(
      warnings,
      /^Requests to the model that failed: (\d+) of \d+\./,
    ),
    severities: finished
      ? Object.fromEntries(
          SEVERITIES.map((severity, index) => [
            severity,
            Number(finished[index + 1]),
          ]),
        )
      : null,
  };
}

// --- Findings as a reader sees them ------------------------------------------

// A line of a finding is cut into pieces this long. `printable()` shortens
// anything over 200 characters, and an escaped character grows to six.
const CHUNK = 120;

const MARKER_LINE = /^<!--.*-->$/;

/**
 * The lines the log shows for a review: the inline comments with `path:line`
 * and the text of the review, without the marker lines. The text comes from
 * the model and from the pull request, so every line goes through
 * `printable()` and starts with a fixed `> `. The runner removes leading
 * spaces before it reads a line as a workflow command (`::error::`), so an
 * indent would not protect; a fixed character does.
 *
 * @param {{ body: string, comments: { path: string, line: number, body: string }[] }} review
 * @returns {string[]}
 */
export function findingLines(review) {
  const lines = [];
  // One logical line, cut into pieces. A line break inside of it (a path can
  // hold one) is shown by `printable()` and does not start a new line.
  const push = (text) => {
    for (let start = 0; start < text.length; start += CHUNK) {
      lines.push(`> ${printable(text.slice(start, start + CHUNK))}`);
    }
  };
  const add = (text) => {
    for (const row of String(text).split(/\r?\n/)) {
      const trimmed = row.trimEnd();
      if (trimmed === "" || MARKER_LINE.test(trimmed.trim())) continue;
      push(trimmed);
    }
  };
  for (const comment of review.comments) {
    push(`${comment.path}:${comment.line}`);
    add(comment.body);
  }
  add(review.body);
  return lines;
}

// --- One run -----------------------------------------------------------------

/**
 * Runs the action once on one pull request and collects the result.
 *
 * @param {object} options
 * @param {{ run: Function, getOctokit: Function, createAiClient: Function, core: object }} options.deps
 * @param {object} options.context From `buildContext()`.
 * @param {string} options.label
 * @param {Record<string, string>} options.inputs
 * @param {string} options.token
 */
export async function runOnce({ deps, context, label, inputs, token }) {
  const { core, record } = createRecordingCore({
    real: deps.core,
    label,
    inputs,
  });
  const counting = createCountingClient(deps.createAiClient);
  const { octokit, posted } = createReadOnlyOctokit(deps.getOctokit(token));

  await deps.run({
    core,
    context,
    getOctokit: () => octokit,
    createAiClient: counting.create,
  });

  const numbers = readNumbers(record);
  const { stats } = counting;
  const failedKinds = Object.values(stats.failed).reduce((a, b) => a + b, 0);
  return {
    error: record.failures[0] ?? null,
    calls: stats.calls,
    failedRequests: Math.max(numbers.failedRequests, failedKinds),
    failed: stats.failed,
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      total: stats.totalTokens,
      withoutUsage: stats.withoutUsage,
    },
    skippedByLimits: numbers.skippedByLimits,
    overMaxComments: numbers.overMaxComments,
    severities: numbers.severities,
    lines: posted.length > 0 ? findingLines(posted[0]) : [],
    postedReviews: posted.length,
  };
}

// --- The whole comparison ----------------------------------------------------

/**
 * Runs every case `runs` times, one after the other, and writes each result
 * to the log as it comes.
 *
 * @param {object} options
 * @param {ReturnType<typeof loadCases>} options.cases
 * @param {number} options.runs
 * @param {string} options.model
 * @param {string} options.apiKey
 * @param {string} options.token
 * @param {{ run: Function, getOctokit: Function, createAiClient: Function, core: object }} options.deps
 * @returns {Promise<object[]>} One row per case and run.
 */
export async function runComparison({
  cases,
  runs,
  model,
  apiKey,
  token,
  deps,
}) {
  const rows = [];
  const inputs = {
    "github-token": token,
    "openai-api-key": apiKey,
    "openai-model": model,
  };

  for (const testCase of cases) {
    const { owner, repo, number } = parsePullRequestRef(testCase.pr);
    deps.core.info(
      `Case ${testCase.id}: ${testCase.pr}, focus ${testCase.focus}, model ${model}, ${runs} runs.`,
    );
    for (const defect of testCase.defects) {
      deps.core.info(
        `Documented defect: ${printable(defect.path)}: ${printable(defect.description)} (${printable(defect.evidence)})`,
      );
    }

    let context;
    try {
      const { data } = await deps
        .getOctokit(token)
        .rest.pulls.get({ owner, repo, pull_number: number });
      context = buildContext({ owner, repo, pull: data });
    } catch (error) {
      // The message of the API stays out: only the status is shown.
      const status = Number.isInteger(error?.status) ? error.status : "none";
      const row = failedRow(
        testCase,
        1,
        `The pull request could not be read (HTTP status ${status}).`,
      );
      rows.push(row);
      deps.core.info(`${testCase.id}: ${row.error}`);
      continue;
    }

    for (let run = 1; run <= runs; run += 1) {
      const label = `${testCase.id} run ${run}/${runs}`;
      const result = await runOnce({ deps, context, label, inputs, token });
      const row = { id: testCase.id, pr: testCase.pr, run, model, ...result };
      rows.push(row);
      for (const line of metricsLines(row)) deps.core.info(line);
      for (const line of row.lines) deps.core.info(line);
    }
  }
  return rows;
}

function failedRow(testCase, run, error) {
  return {
    id: testCase.id,
    pr: testCase.pr,
    run,
    error,
    calls: 0,
    failedRequests: 0,
    failed: {},
    tokens: { input: 0, output: 0, total: 0, withoutUsage: 0 },
    skippedByLimits: 0,
    overMaxComments: 0,
    severities: null,
    lines: [],
    postedReviews: 0,
  };
}

// --- Output ------------------------------------------------------------------

const kindsText = (failed) =>
  Object.entries(failed)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ") || "none";

const severitiesText = (severities) =>
  severities
    ? SEVERITIES.map((s) => `${severities[s]} ${s}`).join(", ")
    : "no result";

/** The figures of one run, as lines of the log. */
export function metricsLines(row) {
  const lines = [
    `${row.id} run ${row.run}: ${row.tokens.input} input / ${row.tokens.output} output tokens, ${row.calls} requests, failed requests ${row.failedRequests} (${kindsText(row.failed)}), files left out by limits ${row.skippedByLimits}, findings over max-comments ${row.overMaxComments}, findings ${severitiesText(row.severities)}.`,
  ];
  // The log of the action says "Posted a review" and names an address. The
  // address is a placeholder: nothing was posted.
  if (row.postedReviews > 0) {
    lines.push(
      `${row.id} run ${row.run}: the review was recorded and not posted to GitHub; the address in the line above leads nowhere.`,
    );
  }
  if (row.tokens.withoutUsage > 0) {
    lines.push(
      `${row.id} run ${row.run}: ${row.tokens.withoutUsage} requests had no token count; the figures are a lower bound.`,
    );
  }
  if (row.error)
    lines.push(`${row.id} run ${row.run}: failed: ${printable(row.error)}`);
  return lines;
}

/** The table for the job summary. It holds figures only, no text of a finding. */
export function renderTable({ model, rows }) {
  const head = [
    `### Model comparison: ${model}`,
    "",
    "| Case | Run | Tokens (in / out) | Requests | Failed | Files left out | Over max-comments | Findings | Result |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const body = rows.map(
    (row) =>
      `| ${row.id} | ${row.run} | ${row.tokens.input} / ${row.tokens.output} | ${row.calls} | ${row.failedRequests} (${kindsText(row.failed)}) | ${row.skippedByLimits} | ${row.overMaxComments} | ${severitiesText(row.severities)} | ${row.error ? "error" : "ok"} |`,
  );
  return [...head, ...body].join("\n");
}
