import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import {
  FINGERPRINT_LENGTH,
  lineFingerprint,
  lineFingerprintsOf,
  textFingerprint,
  textFingerprintsOf,
} from "../src/fingerprint.js";
import { SECRET_PLACEHOLDER, maskSecrets } from "../src/secrets.js";

const printsOf = (patch, path = "a.js") =>
  lineFingerprintsOf({ path, hunks: parsePatch(patch).hunks });

test("is 16 lowercase hex characters", () => {
  assert.match(lineFingerprint("a.js", "let x = 1;"), /^[0-9a-f]{16}$/);
  assert.equal(FINGERPRINT_LENGTH, 16);
});

test("is the same for the same path, line and predecessor", () => {
  assert.equal(
    lineFingerprint("a.js", "let x = 1;", "one"),
    lineFingerprint("a.js", "let x = 1;", "one"),
  );
});

test("stays the same when the line moves, because it does not use the number", () => {
  const before = printsOf("@@ -0,0 +1,2 @@\n+one\n+let x = 1;");
  const after = printsOf("@@ -0,0 +1,4 @@\n+a\n+b\n+one\n+let x = 1;");
  assert.equal(before.get(2), after.get(4));
});

test("changes when the text of the line changes", () => {
  assert.notEqual(
    lineFingerprint("a.js", "let x = 1;"),
    lineFingerprint("a.js", "let x = 2;"),
  );
});

test("changes with the path", () => {
  assert.notEqual(
    lineFingerprint("a.js", "let x = 1;"),
    lineFingerprint("b.js", "let x = 1;"),
  );
});

test("tells equal lines apart by the line before them", () => {
  assert.notEqual(
    lineFingerprint("a.js", "}", "return a;"),
    lineFingerprint("a.js", "}", "return b;"),
  );
  const prints = printsOf("@@ -0,0 +1,4 @@\n+return a;\n+}\n+return b;\n+}");
  assert.notEqual(prints.get(2), prints.get(4));
});

test("tells two masked secrets in one file apart by their surroundings", () => {
  const prints = printsOf(
    `@@ -0,0 +1,4 @@\n+const a = "${SECRET_PLACEHOLDER}";\n+const x = 1;\n+const a = "${SECRET_PLACEHOLDER}";\n+const y = 2;`,
  );
  assert.notEqual(prints.get(1), prints.get(3));
});

test("ignores indentation and runs of white space", () => {
  assert.equal(
    lineFingerprint("a.js", "let x = 1;", "foo()"),
    lineFingerprint("a.js", "\t  let   x\t=  1;  ", "  foo()  "),
  );
});

test("does not mix up a path and a line that read the same when joined", () => {
  assert.notEqual(
    lineFingerprint("a.js", "b c"),
    lineFingerprint("a.js b", "c"),
  );
  assert.notEqual(
    lineFingerprint("a.js", "b", "c"),
    lineFingerprint("a.js", "bc", ""),
  );
});

test("is taken from the masked text, so two different secrets give the same one", () => {
  const token = (fill) => `gh${"p"}_${fill.repeat(12)}`;
  const masked = (fill) => {
    const parsed = parsePatch(`@@ -0,0 +1 @@\n+const t = "${token(fill)}";`);
    const { hunks } = maskSecrets(parsed.hunks);
    assert.ok(hunks[0].lines[0].content.includes(SECRET_PLACEHOLDER));
    return lineFingerprintsOf({ path: "a.js", hunks }).get(1);
  };
  assert.equal(masked("Ab1"), masked("Zy9"));
});

test("lineFingerprintsOf() covers added and context lines, not removed ones", () => {
  const prints = printsOf("@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more");
  assert.deepEqual([...prints.keys()], [1, 2, 3]);
});

test("lineFingerprintsOf() skips a removed line when it looks for the line before", () => {
  const prints = printsOf("@@ -1,2 +1,2 @@\n keep\n-old\n+new");
  assert.equal(prints.get(2), lineFingerprint("a.js", "new", "keep"));
});

test("lineFingerprintsOf() starts every hunk without a line before", () => {
  const prints = printsOf("@@ -1 +1,2 @@\n x\n+y\n@@ -20 +21,2 @@\n z\n+w");
  assert.equal(prints.get(21), lineFingerprint("a.js", "z", ""));
  assert.equal(prints.get(22), lineFingerprint("a.js", "w", "z"));
});

test("lineFingerprintsOf() accepts a file without hunks", () => {
  assert.deepEqual([...lineFingerprintsOf({ path: "a.js" })], []);
});

// --- Text fingerprint (#107) ---------------------------------------------------

test("a text fingerprint is 16 lowercase hex characters", () => {
  assert.match(textFingerprint("let x = 1;"), /^[0-9a-f]{16}$/);
});

test("a text fingerprint depends on the text alone", () => {
  assert.equal(textFingerprint("let  x = 1;  "), textFingerprint("let x = 1;"));
  assert.notEqual(textFingerprint("let x = 1;"), textFingerprint("let x = 2;"));
  // Not the fingerprint of the line: the domains are apart.
  assert.notEqual(
    textFingerprint("let x = 1;"),
    lineFingerprint("", "let x = 1;", ""),
  );
});

test("a line without a letter or a digit has no text fingerprint", () => {
  for (const line of ["}", ");", "  ", "", "  });  ", "// --", "-----"]) {
    assert.equal(textFingerprint(line), null, JSON.stringify(line));
  }
  assert.notEqual(textFingerprint("}  // x"), null);
  assert.notEqual(textFingerprint("1"), null);
  assert.notEqual(textFingerprint(String.fromCodePoint(0xe4)), null);
});

test("textFingerprintsOf() skips lines without substance and removed lines", () => {
  const { hunks } = parsePatch("@@ -1,2 +1,3 @@\n a\n-gone\n+}\n+let b;");
  const prints = textFingerprintsOf({ hunks });
  assert.deepEqual([...prints.keys()], [1, 3]);
  assert.equal(prints.get(3), textFingerprint("let b;"));
  assert.equal(textFingerprintsOf({}).size, 0);
});
