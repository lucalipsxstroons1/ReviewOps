// The logic of the evaluation, without any call to the API: loading the
// reference diffs, judging the answer of one run and building the table.
// `run.mjs` calls the model, and the tests of this repository call this file.
// How a new reference diff is added: docs/eval-cases.md.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AiError, isFatal } from "../src/ai/error.js";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  buildSystemPrompt,
  parseLanguage,
} from "../src/ai/prompt.js";
import { buildUserPrompt } from "../src/ai/user-prompt.js";
import {
  CATEGORIES,
  MAX_OUTPUT_TOKENS,
  REVIEW_FORMAT,
  SEVERITIES,
  parseReview,
} from "../src/ai/schema.js";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
import { printable } from "../src/printable.js";
import { maskSecrets } from "../src/secrets.js";

/** How often every reference diff is sent to the model. */
export const RUNS_PER_CASE = 3;

/**
 * How many of the runs of a case must pass. A defect has to be found in every
 * run: that result was stable across runs. A clean diff may raise one false
 * alarm in `RUNS_PER_CASE` runs, because the model varies from run to run
 * even with the same prompt and the same model (see #12). This differs from
 * the wording of #12 ("3 of 3") and is recorded there.
 *
 * @param {boolean} clean
 * @returns {number}
 */
export function requiredPasses(clean) {
  return clean ? RUNS_PER_CASE - 1 : RUNS_PER_CASE;
}

// The model the prompt is measured with. It is not the default model of the
// action (`gpt-6-luna`, decided in #41): with `gpt-4o-mini` the prompt misses
// the React dependency case (1 of 3 runs), with `gpt-4.1`, `gpt-6-luna` and
// `gpt-6.1-sol` it meets every threshold.
export const REFERENCE_MODEL = "gpt-4.1";

/**
 * The name of the model for the evaluation: `EVAL_MODEL` if it is set and
 * not empty, else the reference model. An empty value is usually an input of
 * a workflow that was not filled in.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string} Not yet checked, `parseModel()` does that.
 */
export function evalModelName(env) {
  const requested = (env.EVAL_MODEL ?? "").trim();
  return requested === "" ? REFERENCE_MODEL : requested;
}

/**
 * The language of the feedback in the evaluation: `EVAL_LANGUAGE`, checked
 * like the input `language` of the action. Empty means English, the default
 * of the action. The thresholds are the same in every language: severity,
 * category, path and line stay in English.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {keyof typeof LANGUAGES}
 * @throws {Error} When the value is not one of the language codes.
 */
export function evalLanguage(env) {
  return parseLanguage(env.EVAL_LANGUAGE ?? "");
}

// "info" is the lowest, "critical" the highest of the schema.
export const SEVERITY_RANK = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity, SEVERITIES.length - index]),
);

const KEYS = ["description", "path", "patch"];

/**
 * Loads the reference diffs from a directory, in the order of their names.
 *
 * @param {string} directory
 * @returns {{
 *   name: string,
 *   description: string,
 *   path: string,
 *   patch: string,
 *   clean: boolean,
 *   expect: { category: string, lines: number[], minSeverity: string } | null,
 *   commentableLines: number[],
 *   user: string,
 * }[]}
 * @throws {Error} Naming the file, when a case is not valid.
 */
export function loadCases(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = file.replace(/\.json$/, "");
      const data = JSON.parse(readFileSync(join(directory, file), "utf8"));
      return toCase(name, data);
    });
}

function toCase(name, data) {
  const fail = (reason) => {
    throw new Error(`Case ${name}: ${reason}`);
  };
  for (const key of KEYS) {
    if (typeof data[key] !== "string" || data[key] === "") {
      fail(`"${key}" must be a non-empty text.`);
    }
  }
  const clean = data.clean === true;
  if (clean === "expect" in data) {
    fail('exactly one of "clean": true and "expect" is needed.');
  }
  const allowed = new Set([...KEYS, clean ? "clean" : "expect"]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) fail(`"${key}" is not a known key.`);
  }

  const parsed = parsePatch(data.patch);
  const { commentableLines } = parsed;
  // Masked as in the action, so the model sees what it would see there.
  const { hunks } = maskSecrets(parsed.hunks);

  let expect = null;
  if (!clean) {
    expect = data.expect;
    if (!CATEGORIES.includes(expect?.category)) fail("unknown category.");
    if (!SEVERITIES.includes(expect.minSeverity)) fail("unknown minSeverity.");
    if (
      !Array.isArray(expect.lines) ||
      expect.lines.length === 0 ||
      !expect.lines.every((line) => commentableLines.includes(line))
    ) {
      fail("every expected line must be an added line of the patch.");
    }
  }

  return {
    name,
    description: data.description,
    path: data.path,
    patch: data.patch,
    clean,
    expect,
    commentableLines,
    // Built by the action's own builder, so the evaluation measures exactly
    // the message the action sends.
    user: buildUserPrompt({
      files: [{ path: data.path, annotated: annotateDiff(hunks) }],
    }),
  };
}

/** A case whose name ends like this carries an embedded instruction. */
export const INJECTION_SUFFIX = "-prompt-injection";

/**
 * The language of a case: the text after the last dot of the file name,
 * in lower case. A name without a dot stands for itself (`Dockerfile`).
 *
 * @param {string} path
 * @returns {string}
 */
export function languageOf(path) {
  const file = path.split(/[\\/]/).pop();
  return file.slice(file.lastIndexOf(".") + 1).toLowerCase();
}

/**
 * Checks the set of reference diffs as a whole. It has no fixed number of
 * cases; it asks for what the measurement needs:
 *
 * 1. at least one case with a defect for every category of `CATEGORIES`,
 *    not counting the cases with an embedded instruction,
 * 2. at least one case with an embedded instruction (name ends on
 *    `-prompt-injection`),
 * 3. at least one clean case for every language that has a case with a
 *    defect (an instruction case counts as a defect case here).
 *
 * @param {ReturnType<typeof loadCases>} cases
 * @returns {string[]} One message per broken rule, empty if the set is fine.
 */
export function checkCaseSet(cases) {
  const messages = [];
  const faulty = cases.filter((testCase) => !testCase.clean);
  const isInjection = (testCase) => testCase.name.endsWith(INJECTION_SUFFIX);

  for (const category of CATEGORIES) {
    const covered = faulty.some(
      (testCase) =>
        !isInjection(testCase) && testCase.expect.category === category,
    );
    if (!covered) {
      messages.push(`No case with a defect for the category "${category}".`);
    }
  }
  if (!faulty.some(isInjection)) {
    messages.push(
      `No case with an embedded instruction (name ends on "${INJECTION_SUFFIX}").`,
    );
  }
  const cleanLanguages = new Set(
    cases.filter((testCase) => testCase.clean).map((c) => languageOf(c.path)),
  );
  for (const language of new Set(faulty.map((c) => languageOf(c.path)))) {
    if (!cleanLanguages.has(language)) {
      messages.push(
        `No clean case for the language "${language}" (a case with a defect uses it).`,
      );
    }
  }
  return messages;
}

const isRealText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Judges the answer of one run for one reference diff.
 *
 * `invalid` counts the findings that cannot become a comment: another file,
 * a line that is not an added line of the diff, or an empty suggestion.
 *
 * @param {ReturnType<typeof loadCases>[number]} testCase
 * @param {{ findings: import("../src/ai/schema.js").Finding[] }} review
 * @returns {{ ok: boolean, invalid: number }}
 */
export function judgeRun(testCase, review) {
  const invalid = review.findings.filter(
    (finding) =>
      finding.path !== testCase.path ||
      !testCase.commentableLines.includes(finding.line) ||
      !isRealText(finding.suggestion),
  ).length;

  if (testCase.clean) {
    const loud = review.findings.some(
      (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.major,
    );
    return { ok: !loud, invalid };
  }

  const { category, lines, minSeverity } = testCase.expect;
  const found = review.findings.some(
    (finding) =>
      finding.path === testCase.path &&
      lines.includes(finding.line) &&
      finding.category === category &&
      SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity],
  );
  return { ok: found, invalid };
}

/**
 * Sums up the runs of one case.
 *
 * @param {{ ok: boolean, invalid: number } | { error: string }} runs One entry per run;
 *   a run that failed is `{ error }` and never counts as a pass.
 * @returns {{ passed: number, runs: number, invalid: number, errors: string[] }}
 */
export function tally(runs) {
  return {
    passed: runs.filter((run) => run.ok === true).length,
    runs: runs.length,
    invalid: runs.reduce((sum, run) => sum + (run.invalid ?? 0), 0),
    errors: runs.filter((run) => "error" in run).map((run) => run.error),
  };
}

/**
 * Applies the thresholds: a defect is found in every run, a clean diff passes
 * in all runs but one (`requiredPasses()`), no finding is invalid. A run that
 * ended with an error is never tolerated, also not when the case still has
 * enough passes: an outage must not hide behind the tolerance.
 *
 * @param {{ name: string, clean: boolean, passed: number, runs: number, invalid: number, errors: string[] }[]} rows
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verdict(rows) {
  const problems = [];
  for (const row of rows) {
    const needed = requiredPasses(row.clean);
    if (row.passed < needed) {
      problems.push(
        `${row.name}: ${row.clean ? "clean" : "found"} in ${row.passed} of ${row.runs} runs (needs ${needed})`,
      );
    } else if (row.errors.length > 0) {
      problems.push(
        `${row.name}: ${row.errors.length} runs ended with an error`,
      );
    }
    if (row.invalid > 0) {
      problems.push(`${row.name}: ${row.invalid} invalid findings`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The result as a Markdown table, for the log and for the job summary. */
export function renderTable({
  model,
  promptVersion,
  language = DEFAULT_LANGUAGE,
  rows,
  result,
}) {
  const lines = [
    `## Prompt evaluation (prompt version ${promptVersion}, model ${model}, language ${LANGUAGES[language]})`,
    "",
    "| Case | Expectation | Passed | Needed | Invalid findings | Errors |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.name} | ${row.clean ? "no finding of major or higher" : "finding of the expected kind"} | ${row.passed}/${row.runs} | ${requiredPasses(row.clean)}/${row.runs} | ${row.invalid} | ${row.errors.length} |`,
    ),
    "",
    result.ok
      ? "Result: all thresholds are met."
      : `Result: thresholds missed.\n\n${result.problems.map((p) => `- ${p}`).join("\n")}`,
  ];
  return lines.join("\n");
}

// The evaluation sends all its requests within seconds. With more than two
// at once it went over the token limit per minute of the reference model on
// the account of this project (#15, #47).
export const MAX_PARALLEL_EVAL_REQUESTS = 2;

// After a rate limit the request is sent again, at most this often and after
// this long. The client has retried twice by then; the limit is counted per
// minute, so a short wait does not help. A rate limit that remains after
// this is an error of the run, as before.
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_WAIT_MS = 20_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Sends one request and waits out a rate limit before it gives up. */
async function completeWithPatience(ai, wait, request) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ai.complete(request);
    } catch (error) {
      const limited = error instanceof AiError && error.kind === "rate_limit";
      if (!limited || attempt >= RATE_LIMIT_RETRIES) throw error;
      await wait(RATE_LIMIT_WAIT_MS);
    }
  }
}

/**
 * Sends every case to the model and judges the answers: `RUNS_PER_CASE` runs
 * in the language of the feedback.
 *
 * A run that fails is recorded as an error and never counts as a pass, so an
 * outage cannot look like "no findings". After an error that repeats for
 * every request (key, permission, model, quota) the remaining runs are not
 * started.
 *
 * @param {object} options
 * @param {ReturnType<typeof loadCases>} options.cases
 * @param {{ complete: (request: object) => Promise<{ content: string, finishReason: string | null }> }} options.ai
 * @param {keyof typeof LANGUAGES} [options.language] A code that
 *   `evalLanguage()` returned.
 * @param {number} [options.concurrency] Requests at the same time.
 * @param {(milliseconds: number) => Promise<void>} [options.wait] Waits
 *   before a request that hit the rate limit is sent again. Tests replace it.
 * @returns {Promise<{
 *   rows: ({ name: string, clean: boolean } & ReturnType<typeof tally>)[],
 *   examples: { name: string, finding: import("../src/ai/schema.js").Finding }[],
 *   failures: { name: string, lines: string[] }[],
 * }>}
 */
export async function runEvaluation({
  cases,
  ai,
  language = DEFAULT_LANGUAGE,
  concurrency = MAX_PARALLEL_EVAL_REQUESTS,
  wait = sleep,
}) {
  const system = buildSystemPrompt({ language });

  const jobs = [];
  for (const testCase of cases) {
    for (let run = 0; run < RUNS_PER_CASE; run += 1) {
      jobs.push({ testCase, result: null });
    }
  }

  let stopped = false;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (stopped) {
        job.result = { error: "not started" };
        continue;
      }
      try {
        const answer = await completeWithPatience(ai, wait, {
          system,
          user: job.testCase.user,
          responseFormat: REVIEW_FORMAT,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        job.review = parseReview(answer);
        job.result = judgeRun(job.testCase, job.review);
      } catch (error) {
        // Anything but an error of the client is a defect of this program.
        if (!(error instanceof AiError)) throw error;
        if (isFatal(error)) stopped = true;
        job.result = { error: error.kind };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker),
  );

  const rows = cases.map((testCase) => ({
    name: testCase.name,
    clean: testCase.clean,
    ...tally(
      jobs.filter((job) => job.testCase === testCase).map((job) => job.result),
    ),
  }));

  // The runs that missed their expectation, to see why. This is the only
  // place that shows text of the model, and it is our own test data. Path and
  // title come from the model, which read the diff. A line break in one of
  // them could start a workflow command in the log, so they go through
  // `printable()`.
  const failures = jobs
    .filter((job) => job.result.ok === false)
    .map((job) => {
      const lines = job.review.findings.map((f) =>
        printable(`${f.path}:${f.line} ${f.severity} ${f.category} ${f.title}`),
      );
      return {
        name: job.testCase.name,
        lines: lines.length ? lines : ["no findings"],
      };
    });

  // One finding per case with a defect, taken from a run that found it, to
  // show what a suggestion looks like. Only the first matching run is used.
  const examples = [];
  for (const testCase of cases.filter((c) => !c.clean)) {
    const job = jobs.find(
      (j) => j.testCase === testCase && j.result.ok === true,
    );
    if (!job) continue;
    const { category, lines } = testCase.expect;
    const finding =
      job.review.findings.find(
        (f) =>
          f.path === testCase.path &&
          lines.includes(f.line) &&
          f.category === category,
      ) ?? job.review.findings[0];
    examples.push({ name: testCase.name, finding });
  }

  return { rows, failures, examples };
}

/**
 * Renders the example findings as Markdown. Every line is quoted (`> `) and
 * goes through `printable()`: the text comes from the model, and a line that
 * starts with `::` would be run as a workflow command in the log. Spaces in
 * front would not help, the runner removes them before it looks at the line.
 *
 * @param {{ name: string, finding: import("../src/ai/schema.js").Finding }[]} examples
 * @returns {string}
 */
export function renderExamples(examples) {
  if (examples.length === 0) return "";
  const indent = (text) =>
    String(text)
      .split("\n")
      .map((line) => `> ${printable(line)}`)
      .join("\n");
  const blocks = examples.map(({ name, finding }) =>
    [
      `### ${name}`,
      "",
      indent(
        `${finding.path}:${finding.line} ${finding.severity} ${finding.category}`,
      ),
      indent(`Title: ${finding.title}`),
      indent(`Comment: ${finding.comment}`),
      indent(`Suggestion: ${finding.suggestion}`),
    ].join("\n"),
  );
  return ["## Example findings", ...blocks].join("\n\n");
}

/**
 * What to do when `OPENAI_API_KEY` is missing. A pull request from a fork
 * gets no secrets, which is no failure. Anything else (a run by hand, a run
 * on a machine) is a mistake that must not look like a pass.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {"skip" | "fail"}
 */
export function missingKeyOutcome(env) {
  return env.GITHUB_EVENT_NAME === "pull_request" ? "skip" : "fail";
}

/**
 * The lines for the log that show why runs missed their expectation. Every
 * finding line starts with `- `: the path and the title come from the model,
 * and a line that starts with `::` would be run as a workflow command.
 *
 * @param {{ name: string, lines: string[] }[]} failures
 * @returns {string[]}
 */
export function failureLines(failures) {
  return failures.flatMap(({ name, lines }) => [
    `${name}: a run missed its expectation. Findings:`,
    ...lines.map((line) => `- ${line}`),
  ]);
}
