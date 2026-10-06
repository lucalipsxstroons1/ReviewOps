import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fromRoot } from "./helpers/run-action.js";

/** All JavaScript files below a directory, relative to the repository. */
function sourcesIn(directory) {
  return readdirSync(fromRoot(directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourcesIn(path);
      return entry.name.endsWith(".js") ? [path] : [];
    },
  );
}

test("no source file can approve or block a pull request", () => {
  // ReviewOps only comments. A review of the type APPROVE could be talked
  // into by an instruction in the diff, and REQUEST_CHANGES would block a
  // merge on the word of a model. The review itself comes with #17, which
  // proves the type at the real review; this test keeps any other type out
  // of the code from now on.
  const files = sourcesIn("src");
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = readFileSync(fromRoot(file), "utf8");
    assert.doesNotMatch(source, /APPROVE|REQUEST_CHANGES/, file);
  }
});
