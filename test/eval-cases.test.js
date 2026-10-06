import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCases } from "../eval/lib.mjs";
import { CATEGORIES } from "../src/ai/schema.js";
import { buildUserPrompt } from "../src/ai/user-prompt.js";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
import { fromRoot } from "./helpers/run-action.js";

const cases = loadCases(fromRoot("eval/cases"));
const faulty = cases.filter((testCase) => !testCase.clean);
const clean = cases.filter((testCase) => testCase.clean);

test("has one case with a defect per focus area and two clean cases", () => {
  assert.equal(cases.length, 6);
  assert.deepEqual(
    faulty.map((testCase) => testCase.expect.category).sort(),
    [...CATEGORIES].sort(),
  );
  assert.equal(clean.length, 2);
});

test("has one clean case in JavaScript/React and one in C#", () => {
  const extensions = clean.map((testCase) => testCase.path.split(".").pop());
  assert.deepEqual(extensions.sort(), ["cs", "jsx"]);
});

test("gives every case a distinct name, path and description", () => {
  for (const key of ["name", "path", "description"]) {
    assert.equal(new Set(cases.map((c) => c[key])).size, cases.length, key);
  }
});

test("expects a line that the model can comment on, in every case with a defect", () => {
  for (const testCase of faulty) {
    assert.ok(testCase.expect.lines.length > 0, testCase.name);
    for (const line of testCase.expect.lines) {
      assert.ok(testCase.commentableLines.includes(line), testCase.name);
    }
    assert.equal(testCase.expect.minSeverity, "major", testCase.name);
  }
});

// The expected lines must hold the defect. A change to a patch that moves
// the lines away from it fails here.
const DEFECT_MARKERS = {
  "code-quality-off-by-one": ["i <= items.length", "items[i].price"],
  "react-missing-dependency": ["useEffect(", "fetchProfile(userId)", "}, []);"],
  "efcore-n-plus-one": [
    "foreach (var order in orders)",
    "_db.OrderItems",
    "i.OrderId == order.Id",
  ],
  "security-command-injection": ["exec(`ping -c 1 ${req.query.host}`"],
};

test("points the expected lines at the defect", () => {
  assert.deepEqual(
    Object.keys(DEFECT_MARKERS).sort(),
    faulty.map((c) => c.name).sort(),
  );
  for (const testCase of faulty) {
    const added = testCase.user
      .split("\n")
      .filter((row) => /^\s*\d+ \| \+/.test(row))
      .map((row) => [Number(/^\s*(\d+)/.exec(row)[1]), row]);
    const expected = added
      .filter(([number]) => testCase.expect.lines.includes(number))
      .map(([, row]) => row)
      .join("\n");
    for (const marker of DEFECT_MARKERS[testCase.name]) {
      assert.ok(expected.includes(marker), `${testCase.name}: "${marker}"`);
    }
  }
});

test("writes the user message the way the action builds it", () => {
  for (const testCase of cases) {
    assert.equal(
      testCase.user,
      buildUserPrompt({
        files: [
          {
            path: testCase.path,
            annotated: annotateDiff(parsePatch(testCase.patch).hunks),
          },
        ],
      }),
    );
    assert.ok(testCase.user.startsWith(`<file path="${testCase.path}">\n`));
    assert.match(testCase.user, /\n +\d+ \| \+/);
  }
});

test("holds no text that looks like a credential", () => {
  const pattern =
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
  for (const testCase of cases) {
    assert.doesNotMatch(testCase.patch, pattern, testCase.name);
  }
});

// --- Invalid cases -----------------------------------------------------------

const VALID = {
  description: "d",
  path: "a.js",
  patch: "@@ -0,0 +1,2 @@\n+one\n+two",
  expect: { category: "security", lines: [2], minSeverity: "major" },
};

function failureFor(t, data) {
  const directory = mkdtempSync(join(tmpdir(), "eval-cases-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "bad.json"), JSON.stringify(data));
  try {
    loadCases(directory);
  } catch (error) {
    return error;
  }
  return assert.fail("expected an error");
}

test("accepts a valid case", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "eval-cases-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "ok.json"), JSON.stringify(VALID));

  const [testCase] = loadCases(directory);

  assert.equal(testCase.name, "ok");
  assert.deepEqual(testCase.commentableLines, [1, 2]);
});

for (const [name, data, message] of [
  [
    "a missing path",
    { ...VALID, path: undefined },
    /"path" must be a non-empty text/,
  ],
  [
    "a missing patch",
    { ...VALID, patch: "" },
    /"patch" must be a non-empty text/,
  ],
  [
    "neither clean nor expect",
    { description: "d", path: "a.js", patch: VALID.patch },
    /exactly one of/,
  ],
  ["both clean and expect", { ...VALID, clean: true }, /exactly one of/],
  ["an unknown key", { ...VALID, note: "x" }, /"note" is not a known key/],
  [
    "an unknown category",
    { ...VALID, expect: { ...VALID.expect, category: "vue" } },
    /unknown category/,
  ],
  [
    "an unknown severity",
    { ...VALID, expect: { ...VALID.expect, minSeverity: "huge" } },
    /unknown minSeverity/,
  ],
  [
    "no expected line",
    { ...VALID, expect: { ...VALID.expect, lines: [] } },
    /every expected line/,
  ],
  [
    "a line that is not in the patch",
    { ...VALID, expect: { ...VALID.expect, lines: [3] } },
    /every expected line/,
  ],
]) {
  test(`refuses a case with ${name} and names the file`, (t) => {
    const error = failureFor(t, data);

    assert.match(error.message, /^Case bad: /);
    assert.match(error.message, message);
  });
}

test("refuses a patch that cannot be read", (t) => {
  const error = failureFor(t, { ...VALID, patch: "not a patch" });

  assert.equal(error.name, "PatchFormatError");
});
