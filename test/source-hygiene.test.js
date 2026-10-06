import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fromRoot } from "./helpers/run-action.js";

const DIRECTORIES = ["src", "test", ".github", ".claude"];
const ROOT_FILES = [
  "action.yml",
  "eslint.config.js",
  "package.json",
  "CLAUDE.md",
  "SECURITY.md",
];
const TEXT_FILE = /\.(js|mjs|json|ya?ml|md)$/;

/** All text files below a directory, as paths relative to the repository. */
function textFilesIn(directory) {
  return readdirSync(fromRoot(directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return textFilesIn(path);
      return TEXT_FILE.test(entry.name) ? [path] : [];
    },
  );
}

// Only numeric code points are used here, never a literal or an escape.
const isInvisible = (codePoint) =>
  (codePoint < 0x20 &&
    codePoint !== 0x09 &&
    codePoint !== 0x0a &&
    codePoint !== 0x0d) ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029 ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069) ||
  codePoint === 0xfeff;

test("no source file contains invisible or control characters", () => {
  // Such characters can break a regular expression, hide text from a reader
  // or change how code is displayed. They are easy to add by accident and
  // impossible to see in a review.
  const files = [...DIRECTORIES.flatMap(textFilesIn), ...ROOT_FILES];
  const findings = [];

  for (const file of files) {
    let line = 1;
    for (const character of readFileSync(fromRoot(file), "utf8")) {
      const codePoint = character.codePointAt(0);
      if (codePoint === 0x0a) line++;
      if (isInvisible(codePoint)) {
        findings.push(`${file}:${line} U+${codePoint.toString(16)}`);
      }
    }
  }

  assert.ok(files.length > 20, "expected to scan the whole repository");
  assert.deepEqual(findings, []);
});
