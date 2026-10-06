// The logic of the evaluation, without any call to the API: loading the
// reference diffs, judging the answer of one run and building the table.
// `run.mjs` calls the model, and the tests of this repository call this file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AiError } from "../src/ai/error.js";
import { buildSystemPrompt } from "../src/ai/prompt.js";
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

/** How often every reference diff is sent to the model. */
export const RUNS_PER_CASE = 3;

// "info" is the lowest, "critical" the highest of the schema.
export const SEVERITY_RANK = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity, SEVERITIES.length - index]),
);

// Words that are German and no other language of the list (and no English
// word), so that an English answer does not pass by accident.
const GERMAN_WORDS = [
  "und",
  "nicht",
  "wird",
  "werden",
  "ist",
  "eine",
  "einen",
  "dass",
  "kann",
  "wenn",
  "oder",
  "aber",
  "dem",
  "den",
  "mit",
  "auf",
  "bei",
  "durch",
  "wurde",
  "sollte",
  "muss",
  "zum",
  "zur",
];
export const MIN_GERMAN_WORDS = 3;

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

  const { hunks, commentableLines } = parsePatch(data.patch);

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
    // The same shape as in the prompt: a `File:` line and the annotated diff.
    user: `File: ${data.path}\n${annotateDiff(hunks)}`,
  };
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
 * Tells whether the text of a review is written in German: it holds at least
 * `MIN_GERMAN_WORDS` different words from a list of typical function words.
 * Only the text that the model writes counts, not code or paths.
 *
 * @param {{ summary: string, findings: { title: string, comment: string, suggestion: string }[] }} review
 * @returns {boolean}
 */
export function looksGerman(review) {
  const text = [
    review.summary,
    ...review.findings.flatMap((f) => [f.title, f.comment, f.suggestion]),
  ]
    .join(" ")
    .toLowerCase();
  const words = new Set(text.match(/\p{L}+/gu) ?? []);
  return (
    GERMAN_WORDS.filter((word) => words.has(word)).length >= MIN_GERMAN_WORDS
  );
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
 * Applies the thresholds of the issue: every case passes in all runs, no
 * finding is invalid, and the German pass is German in every case.
 *
 * @param {{ name: string, clean: boolean, passed: number, runs: number, invalid: number, errors: string[] }[]} rows
 * @param {{ name: string, german: boolean }[]} german
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verdict(rows, german) {
  const problems = [];
  for (const row of rows) {
    if (row.passed !== row.runs) {
      problems.push(
        `${row.name}: ${row.clean ? "clean" : "found"} in ${row.passed} of ${row.runs} runs`,
      );
    }
    if (row.invalid > 0) {
      problems.push(`${row.name}: ${row.invalid} invalid findings`);
    }
  }
  for (const row of german) {
    if (!row.german) problems.push(`${row.name}: feedback is not German`);
  }
  return { ok: problems.length === 0, problems };
}

/** The result as a Markdown table, for the log and for the job summary. */
export function renderTable({ model, promptVersion, rows, german, result }) {
  const lines = [
    `## Prompt evaluation (prompt version ${promptVersion}, model ${model})`,
    "",
    "| Case | Expectation | Passed | Invalid findings | Errors |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.name} | ${row.clean ? "no finding of major or higher" : "finding of the expected kind"} | ${row.passed}/${row.runs} | ${row.invalid} | ${row.errors.length} |`,
    ),
    "",
    "| Case in German | Feedback is German |",
    "|---|---|",
    ...german.map((row) => `| ${row.name} | ${row.german ? "yes" : "no"} |`),
    "",
    result.ok
      ? "Result: all thresholds are met."
      : `Result: thresholds missed.\n\n${result.problems.map((p) => `- ${p}`).join("\n")}`,
  ];
  return lines.join("\n");
}

// After these errors another request is not worth a try.
const FATAL_KINDS = new Set(["auth", "permission", "model", "quota"]);

/**
 * Sends every case to the model and judges the answers: `RUNS_PER_CASE` runs
 * in English, and one more run in German for each case with a defect.
 *
 * A run that fails is recorded as an error and never counts as a pass, so an
 * outage cannot look like "no findings". After an error that repeats for
 * every request (key, permission, model, quota) the remaining runs are not
 * started.
 *
 * @param {object} options
 * @param {ReturnType<typeof loadCases>} options.cases
 * @param {{ complete: (request: object) => Promise<{ content: string, finishReason: string | null }> }} options.ai
 * @param {number} [options.concurrency] Requests at the same time.
 * @returns {Promise<{
 *   rows: ({ name: string, clean: boolean } & ReturnType<typeof tally>)[],
 *   german: { name: string, german: boolean }[],
 *   failures: { name: string, lines: string[] }[],
 * }>}
 */
export async function runEvaluation({ cases, ai, concurrency = 4 }) {
  const systems = {
    en: buildSystemPrompt({ language: "en" }),
    de: buildSystemPrompt({ language: "de" }),
  };

  const jobs = [];
  for (const testCase of cases) {
    for (let run = 0; run < RUNS_PER_CASE; run += 1) {
      jobs.push({ testCase, language: "en", result: null });
    }
  }
  for (const testCase of cases.filter((c) => !c.clean)) {
    jobs.push({ testCase, language: "de", result: null });
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
        const answer = await ai.complete({
          system: systems[job.language],
          user: job.testCase.user,
          responseFormat: REVIEW_FORMAT,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        job.review = parseReview(answer);
        const judged = judgeRun(job.testCase, job.review);
        // The German run only has to be German. Its findings still have to
        // be able to become comments.
        job.result =
          job.language === "de"
            ? { ok: looksGerman(job.review), invalid: judged.invalid }
            : judged;
      } catch (error) {
        // Anything but an error of the client is a defect of this program.
        if (!(error instanceof AiError)) throw error;
        if (FATAL_KINDS.has(error.kind)) stopped = true;
        job.result = { error: error.kind };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker),
  );

  const rows = cases.map((testCase) => {
    const own = jobs.filter((job) => job.testCase === testCase);
    const row = tally(
      own.filter((job) => job.language === "en").map((job) => job.result),
    );
    // Invalid findings count in every run, also in the German one.
    row.invalid = own.reduce((sum, job) => sum + (job.result.invalid ?? 0), 0);
    return { name: testCase.name, clean: testCase.clean, ...row };
  });
  const german = jobs
    .filter((job) => job.language === "de")
    .map((job) => ({
      name: job.testCase.name,
      german: job.result.ok === true,
    }));

  // The findings of the runs that missed their expectation, to see why. This
  // is the only place that shows text of the model, and it is our own test data.
  const failures = jobs
    .filter((job) => job.language === "en" && job.result.ok === false)
    .map((job) => ({
      name: job.testCase.name,
      lines: job.review.findings.length
        ? // Path and title come from the model, which read the diff. A line
          // break in one of them could start a workflow command in the log.
          job.review.findings.map((f) =>
            printable(
              `${f.path}:${f.line} ${f.severity} ${f.category} ${f.title}`,
            ),
          )
        : ["no findings"],
    }));

  return { rows, german, failures };
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
