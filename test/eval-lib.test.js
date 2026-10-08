import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNS_PER_CASE,
  evalLanguage,
  evalModelName,
  failureLines,
  judgeRun,
  loadCases,
  missingKeyOutcome,
  renderExamples,
  renderTable,
  requiredPasses,
  runEvaluation,
  tally,
  verdict,
  MAX_PARALLEL_EVAL_REQUESTS,
  RATE_LIMIT_RETRIES,
  RATE_LIMIT_WAIT_MS,
} from "../eval/lib.mjs";
import { AiError } from "../src/ai/error.js";
import { DEFAULT_MODEL, parseModel } from "../src/ai/model.js";
import { MAX_OUTPUT_TOKENS, REVIEW_FORMAT } from "../src/ai/schema.js";
import { fromRoot } from "./helpers/run-action.js";

const cases = loadCases(fromRoot("eval/cases"));
const faultyCase = cases.find((c) => c.name === "react-missing-dependency");
const cleanCase = cases.find((c) => c.name === "clean-react");

const finding = (testCase, overrides = {}) => ({
  path: testCase.path,
  line: testCase.commentableLines[0],
  severity: "major",
  category: "code-quality",
  title: "A title",
  comment: "A comment",
  suggestion: "A suggestion",
  ...overrides,
});
const hit = (testCase, overrides = {}) =>
  finding(testCase, {
    line: testCase.expect.lines[0],
    category: testCase.expect.category,
    ...overrides,
  });
const review = (...findings) => ({ summary: "s", findings });

// --- judgeRun() --------------------------------------------------------------

test("takes a finding with the right path, line, category and severity as found", () => {
  assert.deepEqual(judgeRun(faultyCase, review(hit(faultyCase))), {
    ok: true,
    invalid: 0,
  });
});

test("takes every line of the expected set and a higher severity as found", () => {
  for (const line of faultyCase.expect.lines) {
    assert.equal(
      judgeRun(faultyCase, review(hit(faultyCase, { line }))).ok,
      true,
    );
  }
  assert.equal(
    judgeRun(faultyCase, review(hit(faultyCase, { severity: "critical" }))).ok,
    true,
  );
});

for (const [name, overrides] of [
  ["another path", { path: "src/other.jsx" }],
  [
    "a line outside of the expected set",
    { line: faultyCase.commentableLines.at(-1) + 50 },
  ],
  ["another category", { category: "security" }],
  ["a severity below the minimum", { severity: "minor" }],
  ["the lowest severity", { severity: "info" }],
]) {
  test(`does not take a finding with ${name} as found`, () => {
    assert.equal(
      judgeRun(faultyCase, review(hit(faultyCase, overrides))).ok,
      false,
    );
  });
}

test("does not take an answer without findings as found", () => {
  assert.equal(judgeRun(faultyCase, review()).ok, false);
});

test("finds the defect among other findings", () => {
  const result = judgeRun(
    faultyCase,
    review(finding(faultyCase, { severity: "info" }), hit(faultyCase)),
  );

  assert.equal(result.ok, true);
});

test("counts findings that cannot become a comment as invalid", () => {
  const notAdded = Math.max(...faultyCase.commentableLines) + 100;
  const result = judgeRun(
    faultyCase,
    review(
      hit(faultyCase),
      hit(faultyCase, { path: "src/other.jsx" }),
      hit(faultyCase, { line: notAdded }),
      hit(faultyCase, { suggestion: "" }),
      hit(faultyCase, { suggestion: "  \n " }),
    ),
  );

  assert.deepEqual(result, { ok: true, invalid: 4 });
});

test("takes a clean diff without findings, or with small ones, as clean", () => {
  assert.equal(judgeRun(cleanCase, review()).ok, true);
  assert.equal(
    judgeRun(
      cleanCase,
      review(
        finding(cleanCase, { severity: "minor" }),
        finding(cleanCase, { severity: "info" }),
      ),
    ).ok,
    true,
  );
});

test("does not take a clean diff with a major or critical finding as clean", () => {
  for (const severity of ["major", "critical"]) {
    assert.equal(
      judgeRun(cleanCase, review(finding(cleanCase, { severity }))).ok,
      false,
    );
  }
});

test("also counts invalid findings on a clean diff", () => {
  const result = judgeRun(
    cleanCase,
    review(finding(cleanCase, { severity: "info", path: "elsewhere.js" })),
  );

  assert.deepEqual(result, { ok: true, invalid: 1 });
});

// --- tally() and verdict() ---------------------------------------------------

test("counts passed runs, invalid findings and errors, and never takes an error as a pass", () => {
  assert.deepEqual(
    tally([
      { ok: true, invalid: 0 },
      { ok: false, invalid: 2 },
      { error: "server" },
    ]),
    { passed: 1, runs: 3, invalid: 2, errors: ["server"] },
  );
});

const row = (overrides = {}) => ({
  name: "case",
  clean: false,
  passed: 3,
  runs: 3,
  invalid: 0,
  errors: [],
  ...overrides,
});

test("meets the thresholds when every defect is found in 3 of 3 runs and nothing is invalid", () => {
  const result = verdict([row(), row({ clean: true })]);

  assert.deepEqual(result, { ok: true, problems: [] });
});

test("requires 3 of 3 runs for a defect and 2 of 3 for a clean diff", () => {
  assert.equal(requiredPasses(false), RUNS_PER_CASE);
  assert.equal(requiredPasses(true), RUNS_PER_CASE - 1);
});

test("tolerates one false alarm in three runs on a clean diff", () => {
  const result = verdict([row({ clean: true, passed: 2 })]);

  assert.deepEqual(result, { ok: true, problems: [] });
});

test("does not tolerate two false alarms in three runs on a clean diff", () => {
  const result = verdict([row({ name: "a", clean: true, passed: 1 })]);

  assert.deepEqual(result, {
    ok: false,
    problems: ["a: clean in 1 of 3 runs (needs 2)"],
  });
});

test("does not tolerate a missed defect in one of three runs", () => {
  const result = verdict([row({ name: "a", passed: 2 })]);

  assert.deepEqual(result, {
    ok: false,
    problems: ["a: found in 2 of 3 runs (needs 3)"],
  });
});

test("does not hide a run that ended with an error behind the tolerance", () => {
  const result = verdict([
    row({ name: "a", clean: true, passed: 2, errors: ["server"] }),
  ]);

  assert.deepEqual(result, {
    ok: false,
    problems: ["a: 1 runs ended with an error"],
  });
});

test("names every missed threshold", () => {
  const result = verdict([
    row({ name: "a", passed: 2 }),
    row({
      name: "b",
      clean: true,
      passed: 0,
      errors: ["server", "server", "server"],
    }),
    row({ name: "c", invalid: 1 }),
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "a: found in 2 of 3 runs (needs 3)",
    "b: clean in 0 of 3 runs (needs 2)",
    "c: 1 invalid findings",
  ]);
});

test("renders the result as a table with the version, the model and the runs needed", () => {
  const rows = [row({ name: "a" }), row({ name: "b", clean: true, passed: 1 })];
  const result = verdict(rows);

  const table = renderTable({
    model: "gpt-4o-mini",
    promptVersion: 7,
    rows,
    result,
  });

  assert.match(
    table,
    /^## Prompt evaluation \(prompt version 7, model gpt-4o-mini, language English\)/,
  );
  assert.match(
    table,
    /\| a \| finding of the expected kind \| 3\/3 \| 3\/3 \| 0 \| 0 \|/,
  );
  assert.match(
    table,
    /\| b \| no finding of major or higher \| 1\/3 \| 2\/3 \| 0 \| 0 \|/,
  );
  assert.doesNotMatch(table, /German/);
  assert.match(table, /Result: thresholds missed\./);
  assert.match(table, /- b: clean in 1 of 3 runs \(needs 2\)/);
});

test("names the language of the feedback in the table", () => {
  const rows = [row({ name: "a" })];

  const table = renderTable({
    model: "gpt-4.1",
    promptVersion: 8,
    language: "de",
    rows,
    result: verdict(rows),
  });

  assert.match(
    table,
    /^## Prompt evaluation \(prompt version 8, model gpt-4\.1, language German\)/,
  );
});

// --- runEvaluation() ---------------------------------------------------------

const byPath = (user) =>
  cases.find((c) => user.includes(`<file path="${c.path}">\n`));

/** A model that finds every defect and is silent on clean code. */
function goodModel(calls) {
  return {
    async complete(request) {
      calls.push(request);
      const testCase = byPath(request.user);
      const text = "This is not good.";
      const findings = testCase.clean
        ? []
        : [hit(testCase, { comment: text, title: text, suggestion: text })];
      return {
        content: JSON.stringify({ summary: text, findings }),
        finishReason: "stop",
      };
    },
  };
}

test("runs every case three times", async () => {
  const calls = [];

  const { rows, failures } = await runEvaluation({
    cases,
    ai: goodModel(calls),
  });

  assert.equal(calls.length, cases.length * RUNS_PER_CASE);
  assert.equal(rows.length, cases.length);
  for (const entry of rows) {
    assert.deepEqual(
      [entry.passed, entry.runs, entry.invalid],
      [3, 3, 0],
      entry.name,
    );
  }
  assert.deepEqual(failures, []);
  assert.equal(verdict(rows).ok, true);
});

test("sends the schema, the output limit and the English prompt", async () => {
  const calls = [];

  await runEvaluation({ cases, ai: goodModel(calls) });

  for (const call of calls) {
    assert.equal(call.responseFormat, REVIEW_FORMAT);
    assert.equal(call.maxOutputTokens, MAX_OUTPUT_TOKENS);
  }
  for (const call of calls) {
    assert.match(call.system, /the suggestion in English\./);
  }
});

test("asks for the feedback in the language it is given", async () => {
  const calls = [];

  const { rows } = await runEvaluation({
    cases,
    ai: goodModel(calls),
    language: "de",
  });

  assert.equal(calls.length, cases.length * RUNS_PER_CASE);
  for (const call of calls) {
    assert.match(call.system, /the suggestion in German\./);
  }
  // The cases are judged by severity, category, path and line, which stay
  // in English: the thresholds are the same.
  assert.equal(verdict(rows).ok, true);
});

test("never takes an error as a pass, also not on a clean diff", async () => {
  const ai = {
    async complete(request) {
      if (byPath(request.user) === cleanCase)
        throw new AiError("server", "down");
      return goodModel([]).complete(request);
    },
  };

  const { rows } = await runEvaluation({ cases, ai });

  const entry = rows.find((r) => r.name === cleanCase.name);
  assert.deepEqual(
    [entry.passed, entry.errors],
    [0, ["server", "server", "server"]],
  );
  assert.equal(verdict(rows).ok, false);
});

test("takes a cut-off answer as an error of the run, not as no findings", async () => {
  const ai = {
    async complete() {
      return { content: '{"summary": "s", "find', finishReason: "length" };
    },
  };

  const { rows } = await runEvaluation({ cases: [cleanCase], ai });

  assert.deepEqual(
    [rows[0].passed, rows[0].errors],
    [0, ["truncated", "truncated", "truncated"]],
  );
});

// --- Rate limits ---------------------------------------------------------------

/** Records the waits instead of waiting. */
const recordWaits = (waits) => async (milliseconds) => {
  waits.push(milliseconds);
};

test("sends at most two requests at once by default", async () => {
  assert.equal(MAX_PARALLEL_EVAL_REQUESTS, 2);
  let running = 0;
  let highest = 0;
  const good = goodModel([]);
  const ai = {
    async complete(request) {
      running += 1;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return good.complete(request);
    },
  };

  await runEvaluation({ cases, ai });

  assert.equal(highest, 2);
});

test("waits out a rate limit and sends the request again", async () => {
  const waits = [];
  const good = goodModel([]);
  let failuresLeft = 2;
  const ai = {
    async complete(request) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new AiError("rate_limit", "limited", 429);
      }
      return good.complete(request);
    },
  };

  const { rows } = await runEvaluation({
    cases: [faultyCase],
    ai,
    concurrency: 1,
    wait: recordWaits(waits),
  });

  assert.deepEqual(waits, [RATE_LIMIT_WAIT_MS, RATE_LIMIT_WAIT_MS]);
  assert.equal(RATE_LIMIT_WAIT_MS, 20000);
  assert.deepEqual([rows[0].passed, rows[0].errors], [3, []]);
});

test("counts a rate limit that stays as an error of the run", async () => {
  const waits = [];
  let calls = 0;
  const ai = {
    async complete() {
      calls += 1;
      throw new AiError("rate_limit", "limited", 429);
    },
  };

  const { rows } = await runEvaluation({
    cases: [cleanCase],
    ai,
    concurrency: 1,
    wait: recordWaits(waits),
  });

  // Three runs, each sent once and then twice more.
  assert.equal(RATE_LIMIT_RETRIES, 2);
  assert.equal(calls, 3 * (1 + RATE_LIMIT_RETRIES));
  assert.equal(waits.length, 3 * RATE_LIMIT_RETRIES);
  assert.deepEqual(rows[0].errors, ["rate_limit", "rate_limit", "rate_limit"]);
  assert.equal(rows[0].passed, 0);
  assert.equal(verdict(rows).ok, false);
});

test("sends a request again only after a rate limit", async () => {
  const waits = [];
  let calls = 0;
  const ai = {
    async complete() {
      calls += 1;
      throw new AiError("server", "down", 500);
    },
  };

  const { rows } = await runEvaluation({
    cases: [cleanCase],
    ai,
    concurrency: 1,
    wait: recordWaits(waits),
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, []);
  assert.deepEqual(rows[0].errors, ["server", "server", "server"]);
});

test("stops after an error that repeats for every request", async () => {
  let calls = 0;
  const ai = {
    async complete() {
      calls += 1;
      throw new AiError("auth", "rejected");
    },
  };

  const { rows } = await runEvaluation({ cases, ai, concurrency: 1 });

  assert.equal(calls, 1);
  assert.equal(
    rows.every((entry) => entry.passed === 0),
    true,
  );
  assert.equal(
    rows.flatMap((entry) => entry.errors).includes("not started"),
    true,
  );
  assert.equal(verdict(rows).ok, false);
});

test("reports a run that missed its expectation with the findings, not the whole answer", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const findings =
        testCase === faultyCase
          ? [finding(testCase, { severity: "minor", title: "SOME-TITLE" })]
          : [];
      return {
        content: JSON.stringify({ summary: "SUMMARY-TEXT", findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows, failures } = await runEvaluation({ cases: [faultyCase], ai });

  assert.equal(rows[0].passed, 0);
  assert.equal(failures.length, 3);
  assert.match(
    failures[0].lines[0],
    /^src\/components\/Profile\.jsx:\d+ minor code-quality SOME-TITLE$/,
  );
  assert.equal(JSON.stringify(failures).includes("SUMMARY-TEXT"), false);
});

test("passes on an error that is not an error of the client", async () => {
  const ai = {
    async complete() {
      throw new TypeError("a defect");
    },
  };

  await assert.rejects(runEvaluation({ cases: [cleanCase], ai }), TypeError);
});

test("writes path and title of a finding so that a line break cannot start a workflow command", async () => {
  const escape = String.fromCodePoint(0x1b);
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const bad = finding(testCase, {
        severity: "minor",
        title: `T\n::warning::INJECTED${escape}[31m`,
        path: `${testCase.path}\n::error::INJECTED`,
      });
      return {
        content: JSON.stringify({ summary: "s", findings: [bad] }),
        finishReason: "stop",
      };
    },
  };

  const { failures } = await runEvaluation({ cases: [faultyCase], ai });
  assert.ok(failures.length > 0);
  for (const { lines } of failures) {
    for (const line of lines) {
      assert.equal(line.includes("\n"), false);
      assert.equal(line.includes(escape), false);
      assert.match(line, /\\u000a::warning::INJECTED/);
    }
  }
});

// --- missingKeyOutcome() -----------------------------------------------------

test("skips the evaluation without a key only in a pull request, which a fork gets no secrets for", () => {
  assert.equal(
    missingKeyOutcome({ GITHUB_EVENT_NAME: "pull_request" }),
    "skip",
  );
});

test("fails without a key in a run by hand, on a push and on a machine", () => {
  for (const env of [
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "" },
    {},
  ]) {
    assert.equal(missingKeyOutcome(env), "fail", JSON.stringify(env));
  }
});

test("counts invalid findings of every run and names them in the verdict", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const findings = [
        hit(testCase),
        hit(testCase, { path: "elsewhere.js" }),
        hit(testCase, { line: 999 }),
        hit(testCase, { suggestion: " " }),
      ];
      return {
        content: JSON.stringify({ summary: "s", findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows } = await runEvaluation({ cases: [faultyCase], ai });

  assert.deepEqual([rows[0].passed, rows[0].invalid], [3, 9]);
  assert.deepEqual(verdict(rows).problems, [
    `${faultyCase.name}: 9 invalid findings`,
  ]);
});

// --- evalModelName() ---------------------------------------------------------

test("measures with the default model of the action unless another one is asked for", () => {
  assert.equal(DEFAULT_MODEL, "gpt-6-luna");
  for (const env of [{}, { EVAL_MODEL: "" }, { EVAL_MODEL: "  \n" }]) {
    assert.equal(evalModelName(env), DEFAULT_MODEL, JSON.stringify(env));
  }
});

test("takes the model of EVAL_MODEL, without surrounding white space", () => {
  assert.equal(evalModelName({ EVAL_MODEL: " gpt-4o-mini\n" }), "gpt-4o-mini");
  assert.equal(
    evalModelName({ EVAL_MODEL: "ft:gpt-4o-mini:org::id" }),
    "ft:gpt-4o-mini:org::id",
  );
});

test("can still measure with another model, `gpt-4.1` included", () => {
  assert.equal(evalModelName({ EVAL_MODEL: "gpt-4.1" }), "gpt-4.1");
  assert.equal(parseModel(evalModelName({ EVAL_MODEL: "gpt-4.1" })), "gpt-4.1");
  assert.equal(parseModel(evalModelName({})), DEFAULT_MODEL);
});

test("passes a run of the evaluation in which a clean diff raises one false alarm", async () => {
  let cleanRuns = 0;
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      // The first run on the clean React case raises a major finding.
      if (testCase === cleanCase) cleanRuns += 1;
      const alarm = testCase === cleanCase && cleanRuns === 1;
      const findings = testCase.clean
        ? alarm
          ? [finding(testCase, { severity: "major" })]
          : []
        : [hit(testCase)];
      return {
        content: JSON.stringify({ summary: "s", findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows } = await runEvaluation({ cases, ai, concurrency: 1 });

  const entry = rows.find((r) => r.name === cleanCase.name);
  assert.equal(entry.passed, 2);
  assert.deepEqual(verdict(rows), { ok: true, problems: [] });
});

// --- examples ----------------------------------------------------------------

test("returns one example finding for every case with a defect, from a run that found it", async () => {
  const calls = [];

  const { examples } = await runEvaluation({
    cases,
    ai: goodModel(calls),
  });

  assert.deepEqual(
    examples.map((entry) => entry.name),
    cases.filter((c) => !c.clean).map((c) => c.name),
  );
  for (const { name, finding: example } of examples) {
    const testCase = cases.find((c) => c.name === name);
    assert.equal(example.path, testCase.path);
    assert.ok(testCase.expect.lines.includes(example.line));
    assert.equal(example.category, testCase.expect.category);
  }
});

test("returns no example for a case in which no run found the defect", async () => {
  const ai = {
    async complete() {
      return {
        content: JSON.stringify({ summary: "s", findings: [] }),
        finishReason: "stop",
      };
    },
  };

  const { examples } = await runEvaluation({ cases: [faultyCase], ai });

  assert.deepEqual(examples, []);
});

// The runner removes the spaces in front of a line before it looks for a
// workflow command. So a line is only safe if its first visible character is
// not the start of `::`.
const startsCommand = (line) => line.trimStart().startsWith("::");

test("renders every line of an example behind a quote mark, so that none starts a workflow command", () => {
  const escape = String.fromCodePoint(0x1b);
  const text = renderExamples([
    {
      name: "a",
      finding: finding(faultyCase, {
        title: "T",
        comment: `c\n::error::INJECTED${escape}[31m`,
        suggestion: "Use this:\n::warning::INJECTED\nconst x = 1;",
      }),
    },
  ]);

  assert.match(text, /^## Example findings\n\n### a\n\n/);
  assert.equal(text.includes(escape), false);
  for (const line of text.split("\n")) {
    assert.equal(startsCommand(line), false, line);
  }
  assert.match(text, /^> Suggestion: Use this:$/m);
  assert.match(text, /^> const x = 1;$/m);
  assert.match(text, /^> ::error::INJECTED\\u001b\[31m$/m);
});

test("renders nothing when there are no examples", () => {
  assert.equal(renderExamples([]), "");
});

test("writes the lines of a missed run so that a path or a title from the model cannot start a workflow command", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const bad = finding(testCase, {
        severity: "minor",
        path: "::error::INJECTED",
        title: "T\n::warning::INJECTED",
      });
      return {
        content: JSON.stringify({ summary: "s", findings: [bad] }),
        finishReason: "stop",
      };
    },
  };

  const { failures } = await runEvaluation({ cases: [faultyCase], ai });
  const lines = failureLines(failures);

  assert.ok(lines.length > 3);
  for (const line of lines) {
    assert.equal(startsCommand(line), false, line);
  }
  assert.ok(lines.some((line) => line.startsWith("- ::error::INJECTED")));
  assert.match(
    lines[0],
    /^react-missing-dependency: a run missed its expectation\. Findings:$/,
  );
});

test("lists nothing when no run missed its expectation", () => {
  assert.deepEqual(failureLines([]), []);
});

// --- evalLanguage() ----------------------------------------------------------

test("evaluates in English unless another language is asked for", () => {
  for (const env of [{}, { EVAL_LANGUAGE: "" }, { EVAL_LANGUAGE: "  \n" }]) {
    assert.equal(evalLanguage(env), "en", JSON.stringify(env));
  }
});

test("takes the language of EVAL_LANGUAGE like the input of the action", () => {
  assert.equal(evalLanguage({ EVAL_LANGUAGE: "de" }), "de");
  assert.equal(evalLanguage({ EVAL_LANGUAGE: " DE\n" }), "de");
});

test("refuses a language that is not one of the codes", () => {
  for (const value of ["german", "xx", "de-DE", "en\nde"]) {
    assert.throws(
      () => evalLanguage({ EVAL_LANGUAGE: value }),
      /^Error: Input `language` must be one of en, de,/,
      JSON.stringify(value),
    );
  }
});
