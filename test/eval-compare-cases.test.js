import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadCases,
  parsePullRequestRef,
  parseRuns,
  validateCases,
} from "../eval/compare/lib.mjs";
import { fromRoot } from "./helpers/run-action.js";

const defect = () => ({
  path: "src/app.js",
  description: "A query runs once per customer.",
  evidence: "https://github.com/octo-org/demo/pull/7",
});

const one = (change = {}) => ({
  id: "ef-n-plus-one",
  pr: "octo-org/demo#7",
  focus: "efcore",
  defects: [defect()],
  ...change,
});

// A case that has no `defects` field at all, not one with an empty value.
const withoutDefects = () => {
  const entry = one();
  delete entry.defects;
  return entry;
};

const valid = (...cases) => ({ cases: cases.length ? cases : [one()] });

test("the list of cases of the repository is valid", () => {
  const cases = loadCases(fromRoot("eval/compare/prs.json"));

  assert.ok(cases.length >= 1);
});

test("the list of false alarms of the repository is valid and documents no defect", () => {
  const cases = loadCases(fromRoot("eval/compare/false-alarms.json"));

  assert.ok(cases.length >= 1);
  for (const testCase of cases) assert.deepEqual(testCase.defects, []);
});

test("accepts a case in the documented format", () => {
  assert.equal(validateCases(valid()).length, 1);
});

test("accepts a case without a documented defect: it measures false alarms", () => {
  assert.equal(validateCases(valid(one({ defects: [] }))).length, 1);
});

const INVALID = [
  ["a file without cases", { cases: [] }, /cases: must be a list/],
  ["a file with another field", { cases: [one()], extra: 1 }, /the file/],
  [
    "a case without a field",
    valid({ ...one(), focus: undefined }),
    /cases\[0\]/,
  ],
  ["a case with another field", valid(one({ note: "x" })), /cases\[0\]/],
  ["an id in upper case", valid(one({ id: "EF" })), /id: must be kebab-case/],
  [
    "an id with an underscore",
    valid(one({ id: "ef_n" })),
    /id: must be kebab-case/,
  ],
  ["a repeated id", valid(one(), one()), /id: must be unique/],
  [
    "a pull request without a number",
    valid(one({ pr: "octo-org/demo" })),
    /pr:/,
  ],
  [
    "a pull request with number 0",
    valid(one({ pr: "octo-org/demo#0" })),
    /pr:/,
  ],
  ["a pull request with a path", valid(one({ pr: "../x/y#1" })), /pr:/],
  [
    "an unknown focus",
    valid(one({ focus: "no-such-focus" })),
    /focus: must be one of/,
  ],
  [
    "defects that are not a list",
    valid(one({ defects: "none" })),
    /defects: must be a list/,
  ],
  [
    "a case without the defects field",
    valid(withoutDefects()),
    /cases\[0\]: must have exactly the fields/,
  ],
  [
    "a defect with another field",
    valid(one({ defects: [{ ...defect(), line: 3 }] })),
    /defects\[0\]: must have exactly/,
  ],
  [
    "an empty path",
    valid(one({ defects: [{ ...defect(), path: "" }] })),
    /defects\[0\]\.path/,
  ],
  [
    "a description with a line break",
    valid(one({ defects: [{ ...defect(), description: "a\nb" }] })),
    /description/,
  ],
  [
    "a description with a code fence",
    valid(one({ defects: [{ ...defect(), description: "use ```x```" }] })),
    /description/,
  ],
  [
    "a description over 300 characters",
    valid(one({ defects: [{ ...defect(), description: "a".repeat(301) }] })),
    /description/,
  ],
  [
    "evidence without https",
    valid(one({ defects: [{ ...defect(), evidence: "http://x.example" }] })),
    /evidence/,
  ],
];

for (const [name, data, expected] of INVALID) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateCases(data), expected);
  });
}

test("a message names the place and never repeats a value", () => {
  const data = valid(one({ id: "SECRET-ID-654321" }));

  assert.throws(
    () => validateCases(data),
    (error) =>
      /cases\[0\]\.id/.test(error.message) && !error.message.includes("654321"),
  );
});

test("splits a pull request reference", () => {
  assert.deepEqual(parsePullRequestRef("octo-org/demo.js#42"), {
    owner: "octo-org",
    repo: "demo.js",
    number: 42,
  });
});

test("reads the number of runs: 3 by default, 1 to 5 otherwise", () => {
  assert.equal(parseRuns(undefined), 3);
  assert.equal(parseRuns(""), 3);
  assert.equal(parseRuns(" 1 "), 1);
  assert.equal(parseRuns("5"), 5);
  for (const bad of ["0", "6", "-1", "2.5", "three", "1e1"]) {
    assert.throws(() => parseRuns(bad), /from 1 to 5/);
  }
});
