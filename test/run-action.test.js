import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  lineEndsToLf,
  readOutputs,
  startAction,
} from "./helpers/run-action.js";

// The helper that reads what the action wrote for the runner. `@actions/core`
// ends its lines with the line ending of the operating system, so the same
// content arrives with `\n` on Linux and with `\r\n` on Windows (#82).

const FILE = [
  "findings-count<<ghadelimiter_1",
  "2",
  "ghadelimiter_1",
  "review-url<<ghadelimiter_2",
  "https://github.com/octo-org/demo/pull/42#pullrequestreview-1",
  "ghadelimiter_2",
  "",
].join("\n");

test("reads the outputs of a file with the line ending of Linux", () => {
  assert.deepEqual(readOutputs(FILE), {
    "findings-count": "2",
    "review-url":
      "https://github.com/octo-org/demo/pull/42#pullrequestreview-1",
  });
});

test("reads the same outputs from a file with the line ending of Windows", () => {
  assert.deepEqual(
    readOutputs(FILE.replaceAll("\n", "\r\n")),
    readOutputs(FILE),
  );
});

test("keeps a multi-line value and drops the carriage returns between its lines", () => {
  const file = "text<<EOF\r\nfirst\r\nsecond\r\nEOF\r\n";

  assert.deepEqual(readOutputs(file), { text: "first\nsecond" });
});

test("reads no outputs from an empty file", () => {
  assert.deepEqual(readOutputs(""), {});
});

test("turns Windows line endings into line feeds and keeps a lone carriage return", () => {
  assert.equal(lineEndsToLf("a\r\nb\r\n"), "a\nb\n");
  assert.equal(lineEndsToLf("a\rb"), "a\rb");
  assert.equal(lineEndsToLf("a\nb"), "a\nb");
});

// A program that writes Windows line endings on every platform, the way
// `@actions/core` does on Windows: to the log, the summary and the outputs.
const folder = mkdtempSync(join(tmpdir(), "reviewops-lineends-"));
after(() => rmSync(folder, { recursive: true, force: true }));

test("startAction returns line feeds for output written with Windows line endings", async () => {
  const program = join(folder, "program.mjs");
  writeFileSync(
    program,
    String.raw`import { appendFileSync } from "node:fs";
process.stdout.write("out 1\r\nout 2\r\n");
process.stderr.write("err 1\r\n");
appendFileSync(process.env.GITHUB_STEP_SUMMARY, "sum 1\r\nsum 2\r\n");
appendFileSync(process.env.GITHUB_OUTPUT, "count<<EOF\r\n3\r\nEOF\r\n");
`,
  );

  const result = await startAction(program, {});

  assert.equal(result.status, 0, result.output);
  assert.equal(result.stdout, "out 1\nout 2\n");
  assert.equal(result.stderr, "err 1\n");
  assert.equal(result.output, "out 1\nout 2\nerr 1\n");
  assert.equal(result.summary, "sum 1\nsum 2\n");
  assert.deepEqual(result.outputs, { count: "3" });
});
