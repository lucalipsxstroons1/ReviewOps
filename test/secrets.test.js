import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
import { SECRET_PLACEHOLDER, maskSecrets } from "../src/secrets.js";

// Stand-ins in the shape of real secrets. They are put together at run time,
// so that no file of this repository contains anything that looks like a
// credential (see CLAUDE.md), and they are no valid secrets.
const repeat = (text, length) => text.repeat(length).slice(0, length);
const FAKE = {
  githubClassic: `gh${"p"}_${repeat("Ab1", 36)}`,
  githubServer: `gh${"s"}_${repeat("Zy9", 36)}`,
  githubFineGrained: `github${"_pat_"}${repeat("Q1w_", 82)}`,
  openaiProject: `sk-${"proj"}-${repeat("aB3_-", 120)}`,
  openaiLegacy: `sk-${repeat("T3stK3y", 48)}`,
  awsAccessKey: `AK${"IA"}${repeat("TESTKEY7", 16)}`,
  awsTemporaryKey: `AS${"IA"}${repeat("TESTKEY7", 16)}`,
  slack: `xox${"b"}-${repeat("1234-abcd", 40)}`,
  stripe: `sk${"_live_"}${repeat("Te5t", 24)}`,
  google: `AI${"za"}${repeat("Te5t_-", 35)}`,
};
const KEY_BEGIN = `-----BEGIN ${"RSA PRIVATE"} KEY-----`;
const KEY_END = `-----END ${"RSA PRIVATE"} KEY-----`;
const KEY_BODY = repeat("TUlJRXBRSUJBQUtD", 64);

/** Parsed hunks of a patch that adds the given lines to a new file. */
function added(...lines) {
  const patch = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
  return parsePatch(patch.join("\n"));
}

const contents = (hunks) =>
  hunks.flatMap((hunk) => hunk.lines.map((line) => line.content));

for (const [name, secret] of Object.entries(FAKE)) {
  test(`masks a ${name} in a line of code`, () => {
    const { hunks } = added(`const token = "${secret}";`, "const x = 1;");

    const result = maskSecrets(hunks);

    assert.deepEqual(contents(result.hunks), [
      `const token = "${SECRET_PLACEHOLDER}";`,
      "const x = 1;",
    ]);
    assert.equal(result.masked, 1);
  });
}

test("masks several secrets in one line and counts each", () => {
  const { hunks } = added(`${FAKE.githubClassic} and ${FAKE.awsAccessKey}`);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    `${SECRET_PLACEHOLDER} and ${SECRET_PLACEHOLDER}`,
  ]);
  assert.equal(result.masked, 2);
});

test("masks a private key block line by line and keeps the line numbers", () => {
  const parsed = added(
    "const key = `",
    KEY_BEGIN,
    KEY_BODY,
    KEY_BODY,
    KEY_END,
    "`;",
  );

  const result = maskSecrets(parsed.hunks);

  assert.deepEqual(contents(result.hunks), [
    "const key = `",
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    "`;",
  ]);
  assert.equal(result.masked, 1);
  // The lines the model may comment on stay where they were.
  assert.deepEqual(
    result.hunks[0].lines.map(({ type, line }) => [type, line]),
    parsed.hunks[0].lines.map(({ type, line }) => [type, line]),
  );
  assert.doesNotMatch(annotateDiff(result.hunks), /TUlJRXBR|BEGIN|END/);
});

test("masks a private key block up to the end of the hunk when its end is missing", () => {
  const { hunks } = added(KEY_BEGIN, KEY_BODY, KEY_BODY);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
  ]);
  assert.equal(result.masked, 1);
});

test("masks a private key that stands on one line", () => {
  const { hunks } = added(
    `{ "key": "${KEY_BEGIN}\\n${KEY_BODY}\\n${KEY_END}\\n", "id": 7 }`,
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    `{ "key": "${SECRET_PLACEHOLDER}\\n", "id": 7 }`,
  ]);
  assert.equal(result.masked, 1);
});

/** A full line of a key body: 64 characters of Base64. */
const body = (index) => `MIIE${String(index).padStart(60, "Q")}`;

test("masks the body lines of a key whose middle changed, without BEGIN and END", () => {
  // A key in a YAML file: the hunk shows only lines of its body.
  const { hunks } = parsePatch(
    [
      "@@ -10,7 +10,7 @@ private_key: |",
      `   ${body(1)}`,
      `   ${body(2)}`,
      `   ${body(3)}`,
      `-  ${body(4)}`,
      `+  ${body(40)}`,
      `   ${body(5)}`,
      `   ${body(6)}`,
      `   ${body(7)}`,
    ].join("\n"),
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), Array(8).fill(SECRET_PLACEHOLDER));
  assert.equal(result.masked, 1);
});

test("continues a key into the next hunk up to its END line", () => {
  const { hunks } = parsePatch(
    [
      "@@ -1,2 +1,4 @@",
      " a",
      `+${KEY_BEGIN}`,
      `+${body(1)}`,
      ` ${body(2)}`,
      "@@ -20,4 +22,5 @@",
      ` ${body(30)}`,
      "+dGVzdA==",
      ` ${KEY_END}`,
      " const after = 1;",
      " c",
    ].join("\n"),
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    "a",
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    "const after = 1;",
    "c",
  ]);
});

test("ends a key that runs out of a hunk at the first line of ordinary code", () => {
  // The END line is outside the diff. The next hunk is far away and holds
  // code, which must still be reviewed.
  const { hunks } = parsePatch(
    [
      "@@ -1,1 +1,3 @@",
      ` ${KEY_BEGIN}`,
      `+${body(1)}`,
      `+${body(2)}`,
      "@@ -90,2 +92,3 @@",
      " function run() {",
      "+  return else1;",
      " }",
    ].join("\n"),
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    "function run() {",
    "  return else1;",
    "}",
  ]);
});

test("masks key body lines in quotes and with escaped line breaks", () => {
  const { hunks } = added(
    "const key = [",
    `  "${body(1)}\\n",`,
    `  '${body(2)}' +`,
    `  \`${body(3)}\`;`,
    "];",
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    "const key = [",
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    "];",
  ]);
});

test("leaves a single Base64 line and ordinary words alone", () => {
  const code = [
    `const hash = "${body(1)}";`,
    "const x = 1;",
    "Lorem",
    "ipsum",
    "integrity sha512-abc+def/ghi==",
    `const short = "${"QUJD".repeat(10)}";`,
    `const other = "${"QUJD".repeat(10)}";`,
  ];
  const { hunks } = added(...code);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), code);
  assert.equal(result.masked, 0);
});

test("masks removed and unchanged lines as well", () => {
  const { hunks } = parsePatch(
    [
      "@@ -1,2 +1,2 @@",
      ` const a = "${FAKE.slack}";`,
      `-const b = "${FAKE.stripe}";`,
      "+const b = process.env.KEY;",
    ].join("\n"),
  );

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    `const a = "${SECRET_PLACEHOLDER}";`,
    `const b = "${SECRET_PLACEHOLDER}";`,
    "const b = process.env.KEY;",
  ]);
  assert.equal(result.masked, 2);
});

test("masks a secret in the section line of a hunk", () => {
  const { hunks } = parsePatch(
    `@@ -1 +1 @@ const t = "${FAKE.githubClassic}"\n-a\n+b`,
  );

  const result = maskSecrets(hunks);

  assert.equal(result.hunks[0].section, `const t = "${SECRET_PLACEHOLDER}"`);
  assert.equal(result.masked, 1);
});

test("leaves ordinary code alone", () => {
  const code = [
    "const password = process.env.DB_PASSWORD;",
    'const apiKey = "";',
    'import { task } from "./sk-utils.js";',
    "const cls = 'sk-loading-spinner-wrapper';",
    "const hash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';",
    "// See https://github.com/settings/tokens",
    "const id = 'AKIA';",
    "-----BEGIN PUBLIC KEY-----",
  ];
  const { hunks } = added(...code);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), code);
  assert.equal(result.masked, 0);
});

test("does not change the hunks it is given", () => {
  const { hunks } = added(FAKE.githubClassic, KEY_BEGIN, KEY_BODY);
  const before = JSON.stringify(hunks);

  maskSecrets(hunks);

  assert.equal(JSON.stringify(hunks), before);
});

test("stays fast on very long lines", () => {
  const { hunks } = added(
    "x".repeat(200000),
    `sk-${"a".repeat(200000)}-`,
    `${"gh"}p_${"a".repeat(200000)}`,
    "-".repeat(200000),
    `${"A".repeat(64)}${" ".repeat(200000)}x`,
    `"${"A".repeat(64)}"${" ".repeat(200000)},${" ".repeat(200000)}x`,
  );

  const started = performance.now();
  maskSecrets(hunks);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 1000, `masking took ${Math.round(elapsed)} ms`);
});

// --- More providers (#110) -----------------------------------------------------

// The formats come from the documentation of the providers or from the list
// of GitHub for secret scanning; the pull request names the source of each.
// Like the others, the stand-ins are put together at run time.
const GITLAB_KINDS = [
  "pat",
  "dt",
  "rt",
  "rtr",
  "cbt",
  "ptt",
  "ft",
  "oas",
  "soat",
  "imt",
  "agent",
  "ffct",
  "wt",
];

/** Name, a stand-in that must be masked, and text that must stay as it is. */
const MORE = [
  {
    name: "an Anthropic API key",
    secret: `sk-${"ant"}-${"api03"}-${repeat("Ab1_-", 90)}`,
    // A CSS class or a name that only starts the same way.
    keep: [
      "sk-ant-design-table-wrapper-large",
      ".sk-ant-header { color: red; }",
      '<div class="sk-ant-design-table-wrapper-large">',
      `sk-${"ant"}-${"api03"}-short`,
      `sk-${"ant"}-${"admin"}-${repeat("Ab1", 20)}`,
    ],
  },
  {
    name: "an Anthropic admin key",
    secret: `sk-${"ant"}-${"admin01"}-${repeat("Zy9_-", 90)}`,
    keep: [],
  },
  {
    name: "an npm token",
    secret: `npm${"_"}${repeat("Ab1", 36)}`,
    keep: [
      "process.env.npm_config_registry",
      "npm_package_version",
      "npm_lifecycle_event",
      `npm${"_"}${repeat("Ab1", 35)}`,
      "npm_",
    ],
  },
  {
    name: "a PyPI token",
    secret: `pypi${"-"}AgEIcHlwaS5vcmc${repeat("Ab1_-", 200)}`,
    keep: [
      "pip install pypi-server",
      "pypi-AgEI",
      `pypi${"-"}AgEIcHlwaS5vcmc${repeat("Ab1", 10)}`,
      "pypi-simple-index",
    ],
  },
  {
    name: "a Docker Hub personal access token",
    secret: `dckr${"_pat_"}${repeat("Ab1_-", 40)}`,
    keep: [`dckr${"_pat_"}`, `dckr${"_pat_"}${repeat("a", 19)}`, "dckr_pat"],
  },
  {
    name: "a Docker Hub organization access token",
    secret: `dckr${"_oat_"}${repeat("Ab1_-", 40)}`,
    keep: [`dckr${"_oat_"}${repeat("a", 19)}`],
  },
  {
    name: "a Hugging Face token",
    secret: `hf${"_"}${repeat("Ab1", 36)}`,
    keep: [
      "from huggingface_hub import hf_hub_download",
      "hf_tokenizer",
      "hf_hub_download(repo_id)",
      `hf${"_"}${repeat("a", 33)}`,
      "HF_TOKEN",
    ],
  },
  ...GITLAB_KINDS.map((kind) => ({
    name: `a GitLab token with the prefix gl${kind}-`,
    secret: `gl${kind}-${repeat("Ab1_-", 40)}`,
    keep: [`gl${kind}-abc`, `gl${kind}-${repeat("a", 19)}`],
  })),
];

for (const { name, secret, keep } of MORE) {
  test(`masks ${name}, also inside quotes and after other text`, () => {
    const { hunks } = added(
      `const token = "${secret}";`,
      `TOKEN=${secret} # deploy`,
      `curl -H "Authorization: Bearer ${secret}" https://example.org`,
    );

    const result = maskSecrets(hunks);

    assert.deepEqual(contents(result.hunks), [
      `const token = "${SECRET_PLACEHOLDER}";`,
      `TOKEN=${SECRET_PLACEHOLDER} # deploy`,
      `curl -H "Authorization: Bearer ${SECRET_PLACEHOLDER}" https://example.org`,
    ]);
    assert.equal(result.masked, 3);
  });

  test(`leaves alone what only looks like ${name}`, () => {
    const lines = keep.length > 0 ? keep : ["const x = 1;"];
    const { hunks } = added(...lines);

    const result = maskSecrets(hunks);

    assert.deepEqual(contents(result.hunks), lines);
    assert.equal(result.masked, 0);
  });

  test(`masks ${name} in a very long line, and stays fast on lines built to be slow`, () => {
    const prefix = secret.slice(0, secret.indexOf(repeat("Ab1", 1)) || 10);
    const lines = [
      // The secret in the middle of a huge line.
      `${"x ".repeat(25000)}${secret}${" x".repeat(25000)}`,
      // The start over and over, never completed.
      secret.slice(0, 12).repeat(8000),
      // The start with an endless rest.
      `${secret}${"a".repeat(100000)}`,
      `${prefix}${"-".repeat(100000)}`,
      `${prefix}${"_".repeat(100000)}x`,
      "a".repeat(100000),
    ];
    const { hunks } = added(...lines);

    const started = performance.now();
    const result = maskSecrets(hunks);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 1000, `masking took ${Math.round(elapsed)} ms`);
    assert.ok(contents(result.hunks)[0].includes(SECRET_PLACEHOLDER));
  });
}

test("masks the part of a GitLab token before the first dot", () => {
  const token = `gl${"pat"}-${repeat("Ab1_-", 40)}`;
  const { hunks } = added(`${token}.01.abc12def`);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    `${SECRET_PLACEHOLDER}.01.abc12def`,
  ]);
});

test("leaves the session cookie of GitLab alone: it has no prefix of its own", () => {
  const { hunks } = added(`_gitlab_session=${repeat("Ab1", 12)}`);

  assert.equal(maskSecrets(hunks).masked, 0);
});

test("masks several of the new formats in one line and counts each", () => {
  const first = `sk-${"ant"}-${"api03"}-${repeat("Ab1_-", 20)}`;
  const second = `npm${"_"}${repeat("Ab1", 36)}`;
  const { hunks } = added(`${first} ${second}`);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), [
    `${SECRET_PLACEHOLDER} ${SECRET_PLACEHOLDER}`,
  ]);
  assert.equal(result.masked, 2);
});

test("leaves a connection string with a password alone, on purpose", () => {
  // Generic patterns hit tests and examples (see the comment at the top of
  // src/secrets.js). The files that hold such strings for real, the
  // appsettings*.json files, are never sent at all (src/exclude.js).
  const lines = [
    'var cs = "Server=db;Database=app;User Id=sa;Password=Sup3rS3cret!;";',
    "ConnectionStrings__Default: Host=db;Username=app;Password=changeme",
    "DATABASE_URL=postgres://user:pass@db:5432/app",
    'password = "hunter2"',
  ];
  const { hunks } = added(...lines);

  const result = maskSecrets(hunks);

  assert.deepEqual(contents(result.hunks), lines);
  assert.equal(result.masked, 0);
});
