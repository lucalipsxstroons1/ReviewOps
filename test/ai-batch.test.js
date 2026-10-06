import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REQUEST_CHARS,
  planBatches,
  requestSize,
} from "../src/ai/batch.js";
import { buildUserPrompt } from "../src/ai/user-prompt.js";

/** A file whose annotated diff has exactly `size` characters. */
const fileOf = (path, size) => ({ path, annotated: "x".repeat(size) });

/** Length of the block of a file: tag, line breaks and diff. */
const blockLength = (file) =>
  `<file path="${file.path}">\n`.length +
  file.annotated.length +
  "\n</file>".length;

const paths = (batches) =>
  batches.map((batch) => batch.files.map((file) => file.path));

test("the budget of one request is 50000 characters", () => {
  assert.equal(MAX_REQUEST_CHARS, 50000);
});

test("sends a small pull request in one request", () => {
  const files = [fileOf("a.js", 100), fileOf("b.js", 200)];

  const batches = planBatches({ files });

  assert.deepEqual(paths(batches), [["a.js", "b.js"]]);
  assert.equal(batches[0].user, buildUserPrompt({ files }));
});

test("spreads a pull request over the budget across several requests", () => {
  const files = [
    fileOf("a.js", 30000),
    fileOf("b.js", 30000),
    fileOf("c.js", 10000),
  ];

  const batches = planBatches({ files });

  assert.deepEqual(paths(batches), [["a.js"], ["b.js", "c.js"]]);
  for (const batch of batches) {
    assert.ok(batch.user.length <= MAX_REQUEST_CHARS);
    assert.match(batch.user, /^<file path="/);
  }
});

test("fills a request up to the last character and starts the next after it", () => {
  const a = fileOf("a.js", 100);
  const b = fileOf("b.js", 100);
  const exact = buildUserPrompt({ files: [a, b] }).length;

  assert.deepEqual(paths(planBatches({ files: [a, b], maxChars: exact })), [
    ["a.js", "b.js"],
  ]);
  assert.deepEqual(paths(planBatches({ files: [a, b], maxChars: exact - 1 })), [
    ["a.js"],
    ["b.js"],
  ]);
});

test("keeps the order of the files and does not reach back to fill gaps", () => {
  // c.js would fit next to a.js, but the requests follow the order of GitHub.
  const files = [
    fileOf("a.js", 20000),
    fileOf("b.js", 40000),
    fileOf("c.js", 1000),
  ];

  assert.deepEqual(paths(planBatches({ files })), [["a.js"], ["b.js", "c.js"]]);
});

test("returns no request for no files", () => {
  assert.deepEqual(planBatches({ files: [] }), []);
});

test("refuses a file that is larger than one request on its own", () => {
  const big = fileOf("big.js", MAX_REQUEST_CHARS);

  assert.throws(
    () => planBatches({ files: [fileOf("a.js", 10), big] }),
    /larger than one request/,
  );
});

test("measures a single file as one request would", () => {
  const file = fileOf("src/a.js", 1234);

  assert.equal(requestSize(file), buildUserPrompt({ files: [file] }).length);
  assert.equal(requestSize(file), blockLength(file));
});

test("never splits a file and never sends one twice, for many sizes", () => {
  // A fixed generator, so a failure can be repeated.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let round = 0; round < 300; round += 1) {
    const maxChars = 200 + Math.floor(random() * 2000);
    const count = Math.floor(random() * 30);
    const files = [];
    for (let index = 0; index < count; index += 1) {
      const file = fileOf(`f${index}.js`, Math.floor(random() * 400));
      // Only files that fit on their own reach the batching.
      if (requestSize(file) <= maxChars) files.push(file);
    }

    const batches = planBatches({ files, maxChars });

    const sent = batches.flatMap((batch) => batch.files);
    assert.deepEqual(sent, files, `round ${round}: every file once, in order`);
    for (const batch of batches) {
      assert.ok(batch.files.length > 0);
      assert.ok(batch.user.length <= maxChars, `round ${round}: too long`);
      assert.equal(batch.user, buildUserPrompt({ files: batch.files }));
      // Each file appears whole in its request and in no other.
      for (const file of files) {
        const inside = batch.files.includes(file);
        const block = `<file path="${file.path}">\n${file.annotated}\n</file>`;
        assert.equal(batch.user.includes(block), inside);
        assert.equal(batch.user.includes(`<file path="${file.path}">`), inside);
      }
    }
    // No two neighbouring requests could have been one.
    for (let index = 1; index < batches.length; index += 1) {
      const joined = buildUserPrompt({
        files: [...batches[index - 1].files, batches[index].files[0]],
      });
      assert.ok(joined.length > maxChars, `round ${round}: needless split`);
    }
  }
});

test("splits 3000 small files quickly", () => {
  const files = Array.from({ length: 3000 }, (_, index) =>
    fileOf(`src/file-${index}.js`, 20),
  );

  const started = performance.now();
  const batches = planBatches({ files });
  const elapsed = performance.now() - started;

  assert.deepEqual(
    batches.flatMap((batch) => batch.files),
    files,
  );
  assert.ok(batches.every((batch) => batch.user.length <= MAX_REQUEST_CHARS));
  assert.ok(elapsed < 1000, `batching took ${Math.round(elapsed)} ms`);
});

test("does not change the files it is given", () => {
  const files = [fileOf("a.js", 30000), fileOf("b.js", 30000)];
  const before = JSON.stringify(files);

  planBatches({ files });

  assert.equal(JSON.stringify(files), before);
});
