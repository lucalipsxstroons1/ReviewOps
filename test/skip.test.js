import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_LABEL_LENGTH,
  parseSkipOptions,
  readSkipFacts,
  skipReason,
} from "../src/skip.js";

const options = (change = {}) => ({
  reviewDrafts: false,
  skipLabel: "no-ai-review",
  reviewBots: false,
  ...change,
});

const facts = (change = {}) => ({
  action: "synchronize",
  isDraft: false,
  authorIsBot: false,
  labels: [],
  removedLabel: null,
  ...change,
});

// --- Inputs ------------------------------------------------------------------

test("an empty input means the default: no drafts, no bots, no label", () => {
  assert.deepEqual(parseSkipOptions(), {
    reviewDrafts: false,
    skipLabel: null,
    reviewBots: false,
  });
  assert.deepEqual(
    parseSkipOptions({ reviewDrafts: " ", skipLabel: "  ", reviewBots: "" }),
    { reviewDrafts: false, skipLabel: null, reviewBots: false },
  );
});

test("reads true and false without regard to case and white space", () => {
  assert.deepEqual(
    parseSkipOptions({ reviewDrafts: " TRUE ", reviewBots: "False" }),
    { reviewDrafts: true, skipLabel: null, reviewBots: false },
  );
});

for (const value of ["yes", "1", "on", "truee", "0"]) {
  test(`rejects "${value}" for review-drafts and review-bots`, () => {
    assert.throws(
      () => parseSkipOptions({ reviewDrafts: value }),
      /Input `review-drafts` must be true or false/,
    );
    assert.throws(
      () => parseSkipOptions({ reviewBots: value }),
      /Input `review-bots` must be true or false/,
    );
  });
}

test("a value that cannot be used is written as one harmless line", () => {
  const value = "yes\n::error::fake";

  assert.throws(
    () => parseSkipOptions({ reviewDrafts: value }),
    (error) =>
      !error.message.includes("\n") && error.message.includes("\\u000a"),
  );
});

test("takes the label as it is, without the white space around it", () => {
  assert.equal(
    parseSkipOptions({ skipLabel: "  No-AI-Review " }).skipLabel,
    "No-AI-Review",
  );
});

test("accepts a label of 50 characters and rejects one of 51", () => {
  assert.equal(
    parseSkipOptions({ skipLabel: "a".repeat(MAX_LABEL_LENGTH) }).skipLabel,
    "a".repeat(MAX_LABEL_LENGTH),
  );
  assert.throws(
    () => parseSkipOptions({ skipLabel: "a".repeat(MAX_LABEL_LENGTH + 1) }),
    /Input `skip-label` is longer than 50 characters/,
  );
});

test("counts the length of a label in characters, not in code units", () => {
  const emoji = String.fromCodePoint(0x1f600);

  assert.equal(
    parseSkipOptions({ skipLabel: emoji.repeat(50) }).skipLabel,
    emoji.repeat(50),
  );
  assert.throws(() => parseSkipOptions({ skipLabel: emoji.repeat(51) }));
});

// --- The event ---------------------------------------------------------------

const event = (payload) => readSkipFacts({ payload });

test("reads the facts of an ordinary pull request", () => {
  assert.deepEqual(
    event({
      action: "labeled",
      pull_request: {
        draft: true,
        user: { type: "Bot" },
        labels: [{ name: "No-AI-Review" }, { name: "bug" }],
      },
      label: { name: "Bug" },
    }),
    {
      action: "labeled",
      isDraft: true,
      authorIsBot: true,
      labels: ["no-ai-review", "bug"],
      removedLabel: "bug",
    },
  );
});

test("a payload without pull request, labels and author gives safe values", () => {
  const empty = {
    action: null,
    isDraft: false,
    authorIsBot: false,
    labels: [],
    removedLabel: null,
  };

  assert.deepEqual(readSkipFacts({}), empty);
  assert.deepEqual(readSkipFacts(undefined), empty);
  assert.deepEqual(event({ pull_request: "text" }), empty);
  assert.deepEqual(event({ pull_request: { labels: "bug" } }), empty);
});

test("only a draft that is true counts as a draft, and only the type Bot as a bot", () => {
  assert.equal(event({ pull_request: { draft: "true" } }).isDraft, false);
  assert.equal(
    event({ pull_request: { user: { type: "bot" } } }).authorIsBot,
    false,
  );
  assert.equal(
    event({ pull_request: { user: { type: "User" } } }).authorIsBot,
    false,
  );
});

test("leaves out labels that are not names and names that are too long", () => {
  const found = event({
    pull_request: {
      labels: [
        { name: 5 },
        null,
        {},
        { name: "x".repeat(101) },
        { name: "ok" },
      ],
    },
    label: { name: ["list"] },
  });

  assert.deepEqual(found.labels, ["ok"]);
  assert.equal(found.removedLabel, null);
});

test("looks at no more than 100 labels", () => {
  const labels = Array.from({ length: 150 }, (_, index) => ({
    name: `label-${index}`,
  }));

  assert.equal(event({ pull_request: { labels } }).labels.length, 100);
});

// --- The decision ------------------------------------------------------------

test("reviews an ordinary pull request", () => {
  assert.equal(skipReason(facts(), options()), null);
});

test("skips a pull request with the skip label, without regard to case", () => {
  const reason = skipReason(
    facts({ labels: ["no-ai-review"] }),
    options({ skipLabel: "No-AI-Review" }),
  );

  assert.equal(reason.code, "label");
  assert.match(reason.text, /the label "No-AI-Review" \(input skip-label\)/);
});

test("skips nothing for a label when the skip label is switched off", () => {
  assert.equal(
    skipReason(
      facts({ labels: ["no-ai-review"] }),
      options({ skipLabel: null }),
    ),
    null,
  );
});

test("skips a draft unless drafts are reviewed", () => {
  assert.equal(skipReason(facts({ isDraft: true }), options()).code, "draft");
  assert.equal(
    skipReason(facts({ isDraft: true }), options({ reviewDrafts: true })),
    null,
  );
});

test("skips a pull request of a bot unless bots are reviewed", () => {
  assert.equal(skipReason(facts({ authorIsBot: true }), options()).code, "bot");
  assert.equal(
    skipReason(facts({ authorIsBot: true }), options({ reviewBots: true })),
    null,
  );
});

test("the first reason counts: label, then draft, then bot", () => {
  const all = facts({
    labels: ["no-ai-review"],
    isDraft: true,
    authorIsBot: true,
  });

  assert.equal(skipReason(all, options()).code, "label");
  assert.equal(skipReason({ ...all, labels: [] }, options()).code, "draft");
  assert.equal(
    skipReason({ ...all, labels: [], isDraft: false }, options()).code,
    "bot",
  );
});

test("takes the skip label off: the review starts", () => {
  assert.equal(
    skipReason(
      facts({ action: "unlabeled", removedLabel: "no-ai-review" }),
      options(),
    ),
    null,
  );
});

test("takes another label off: the run is skipped", () => {
  const reason = skipReason(
    facts({ action: "unlabeled", removedLabel: "bug" }),
    options(),
  );

  assert.equal(reason.code, "label-change");
});

test("takes a label off while the skip label is still there: the label counts", () => {
  const reason = skipReason(
    facts({
      action: "unlabeled",
      removedLabel: "bug",
      labels: ["no-ai-review"],
    }),
    options(),
  );

  assert.equal(reason.code, "label");
});

test("takes a label off when the skip label is switched off: the run is skipped", () => {
  assert.equal(
    skipReason(
      facts({ action: "unlabeled", removedLabel: "no-ai-review" }),
      options({ skipLabel: null }),
    ).code,
    "label-change",
  );
});

test("an unlabeled event that names no label is skipped as well", () => {
  assert.equal(
    skipReason(facts({ action: "unlabeled", removedLabel: null }), options())
      .code,
    "label-change",
  );
});

test("another action than unlabeled is never skipped for a label change", () => {
  for (const action of [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "labeled",
    null,
  ]) {
    assert.equal(
      skipReason(facts({ action, removedLabel: "bug" }), options()),
      null,
    );
  }
});

test("a draft that is made ready is reviewed", () => {
  assert.equal(
    skipReason(
      facts({ action: "ready_for_review", isDraft: false }),
      options(),
    ),
    null,
  );
});

test("the texts hold nothing from the event, and the label name is made harmless", () => {
  const reason = skipReason(
    facts({ labels: ["x\ny"] }),
    options({ skipLabel: "x\ny" }),
  );

  assert.ok(!reason.text.includes("\n"));
  assert.ok(reason.text.includes("\\u000a"));
});
