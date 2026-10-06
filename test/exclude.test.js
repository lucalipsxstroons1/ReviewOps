import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EXCLUDES,
  MATCH_OPTIONS,
  createExcludeFilter,
} from "../src/exclude.js";

const BACKSLASH = String.fromCodePoint(0x5c);
const LINE_FEED = String.fromCodePoint(0x0a);
const CARRIAGE_RETURN = String.fromCodePoint(0x0d);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const ESCAPE = String.fromCodePoint(0x1b);

/** The exclude input of a workflow: one pattern per line. */
const input = (...lines) => lines.join("\n");

// --- The default list --------------------------------------------------------

const EXCLUDED_BY_DEFAULT = [
  // Lockfiles, at the root and in a sub-project
  ["package-lock.json", "package-lock.json"],
  ["frontend/package-lock.json", "package-lock.json"],
  ["yarn.lock", "yarn.lock"],
  ["apps/web/pnpm-lock.yaml", "pnpm-lock.yaml"],
  ["src/Api/packages.lock.json", "packages.lock.json"],
  // Build output, in any directory
  ["dist/index.js", "**/dist/**"],
  ["packages/app/dist/deep/er/index.js", "**/dist/**"],
  [".hidden/dist/a.js", "**/dist/**"],
  ["build/static/js/main.js", "**/build/**"],
  ["src/App/obj/Debug/net8.0/App.AssemblyInfo.cs", "**/obj/**"],
  ["public/js/app.min.js", "*.min.js"],
  ["public/js/app.js.map", "*.map"],
  // Generated code
  ["src/App/Generated/Regex.g.cs", "*.g.cs"],
  ["src/App/Migrations/20240101120000_AddUsers.Designer.cs", "*.Designer.cs"],
  ["src/App/Migrations/AppDbContextModelSnapshot.cs", "*ModelSnapshot.cs"],
  ["src/__snapshots__/App.test.js.snap", "*.snap"],
  // Images, fonts, documents and archives
  ["assets/logo.png", "*.png"],
  ["assets/photo.jpeg", "*.jpeg"],
  ["assets/icon.svg", "*.svg"],
  ["public/fonts/inter.woff2", "*.woff2"],
  ["docs/manual.pdf", "*.pdf"],
  ["vendor/lib.zip", "*.zip"],
  ["backup/data.tar", "*.tar"],
  // Upper and lower case make no difference
  ["assets/LOGO.PNG", "*.png"],
  ["src/Forms/Main.designer.cs", "*.Designer.cs"],
  ["DIST/index.js", "**/dist/**"],
];

for (const [path, pattern] of EXCLUDED_BY_DEFAULT) {
  test(`leaves ${path} out by default`, () => {
    const reasonFor = createExcludeFilter();

    assert.equal(
      reasonFor(path),
      `matches the default exclude pattern "${pattern}"`,
    );
  });
}

const REVIEWED_BY_DEFAULT = [
  "src/main.js",
  "README.md",
  "docs/guide.md",
  "package.json",
  "lib/package-lock.json.md",
  "my-package-lock.json",
  // The migration itself, next to its generated files
  "src/App/Migrations/20240101120000_AddUsers.cs",
  "src/App/Models/ModelSnapshotReader.cs",
  // Names that only resemble an excluded directory
  "src/distribution/a.js",
  "src/dist.js",
  "src/build.js",
  "src/builder/index.js",
  "src/object/a.cs",
  // A file that is named like an excluded directory, such as a build script
  "build",
  "scripts/build",
  "dist",
  "src/obj",
  // Hand-written scripts live in bin/
  "bin/cli.js",
  "packages/tool/bin/run.js",
  // Names that only resemble an excluded extension
  "src/mapper.js",
  "src/snapshot.js",
  "src/app.min.jsx",
  "src/png.js",
];

for (const path of REVIEWED_BY_DEFAULT) {
  test(`keeps ${path} by default`, () => {
    assert.equal(createExcludeFilter()(path), null);
  });
}

test("does not read a backslash in a file name as a directory", () => {
  // On Linux a backslash is an ordinary character of a file name. This file
  // lies in the root directory, not in dist/.
  const reasonFor = createExcludeFilter();

  assert.equal(reasonFor(`dist${BACKSLASH}evil.js`), null);
  assert.equal(reasonFor(`src${BACKSLASH}dist${BACKSLASH}evil.js`), null);
});

test("leaves out a file whose name contains a line break", () => {
  // A line break is a legal character of a file name. The wildcards of
  // picomatch stop at one, so without care such a file would slip through.
  const reasonFor = createExcludeFilter("docs/**");

  for (const lineBreak of [
    LINE_FEED,
    CARRIAGE_RETURN,
    LINE_SEPARATOR,
    PARAGRAPH_SEPARATOR,
  ]) {
    assert.equal(
      reasonFor(`dist/a${lineBreak}b.js`),
      'matches the default exclude pattern "**/dist/**"',
    );
    assert.equal(
      reasonFor(`a${lineBreak}b/dist/c.js`),
      'matches the default exclude pattern "**/dist/**"',
    );
    assert.equal(
      reasonFor(`src/a${lineBreak}b.min.js`),
      'matches the default exclude pattern "*.min.js"',
    );
    assert.equal(
      reasonFor(`docs/a${lineBreak}b.md`),
      'matches the exclude pattern "docs/**"',
    );
    assert.equal(reasonFor(`src/a${lineBreak}b.js`), null);
  }
});

test("matches with fixed options, the same on every machine", () => {
  // `nobrace` and `noextglob` cannot be reached through the filter: patterns
  // that use braces are rejected before. They stay as a second safeguard,
  // and this test notices when one of them is dropped.
  assert.ok(Object.isFrozen(MATCH_OPTIONS));
  assert.deepEqual(MATCH_OPTIONS, {
    dot: true,
    nocase: true,
    windows: false,
    nobrace: true,
    noextglob: true,
  });
});

test("the default list cannot be changed and leaves bin/ alone", () => {
  assert.ok(Object.isFrozen(DEFAULT_EXCLUDES));
  assert.deepEqual(
    DEFAULT_EXCLUDES.filter((pattern) => /bin/.test(pattern)),
    [],
  );
});

test("every default pattern follows the rules for own patterns", () => {
  assert.doesNotThrow(() => createExcludeFilter(input(...DEFAULT_EXCLUDES)));
  assert.ok(DEFAULT_EXCLUDES.length <= 50);
});

// --- Own patterns ------------------------------------------------------------

test("adds own patterns to the default list", () => {
  const reasonFor = createExcludeFilter("docs/**");

  assert.equal(
    reasonFor("docs/guide/intro.md"),
    'matches the exclude pattern "docs/**"',
  );
  assert.equal(
    reasonFor("package-lock.json"),
    'matches the default exclude pattern "package-lock.json"',
  );
  assert.equal(reasonFor("src/main.js"), null);
});

test("uses only the default list when the input is empty", () => {
  for (const empty of [undefined, "", "   ", "\n\n"]) {
    const reasonFor = createExcludeFilter(empty);

    assert.equal(reasonFor("docs/guide.md"), null);
    assert.notEqual(reasonFor("yarn.lock"), null);
  }
});

const OWN_PATTERNS = [
  // Without a slash: in every directory
  ["*.generated.cs", "src/Api/Client.generated.cs", true],
  ["*.generated.cs", "Client.generated.cs", true],
  ["CHANGELOG.md", "packages/app/CHANGELOG.md", true],
  ["CHANGELOG.md", "packages/app/CHANGELOG.md.bak", false],
  // With a slash: from the root of the repository
  ["docs/**", "docs/a.md", true],
  ["docs/**", "src/docs/a.md", false],
  ["src/**/*.test.js", "src/a/b/c.test.js", true],
  ["src/**/*.test.js", "src/c.test.js", true],
  ["src/**/*.test.js", "lib/c.test.js", false],
  ["**/fixtures/**", "test/fixtures/data.json", true],
  // A trailing slash means the directory
  ["docs/", "docs/a.md", true],
  ["docs/", "src/docs/a.md", false],
  // A directory pattern means the files below, not a file with that name
  ["docs/**", "docs", false],
  ["docs/", "docs", false],
  ["**/generated/**", "src/generated", false],
  ["**/generated/**", "src/generated/.keep", true],
  ["**/generated/**", "src/generated/a/b/c.cs", true],
  ["docs", "docs", true],
  // A leading slash ties the name to the root
  ["/README.md", "README.md", true],
  ["/README.md", "docs/README.md", false],
  ["./docs/**", "docs/a.md", true],
  // Upper and lower case, dot files, single characters, classes
  ["DOCS/**", "docs/a.md", true],
  ["*.yml", ".github/workflows/ci.yml", true],
  ["v?.md", "notes/v2.md", true],
  ["v?.md", "notes/v10.md", false],
  ["file[0-9].txt", "data/file7.txt", true],
  ["file[0-9].txt", "data/fileX.txt", false],
  // Everything
  ["**", "anything/at/all.js", true],
];

for (const [pattern, path, expected] of OWN_PATTERNS) {
  test(`"${pattern}" ${expected ? "leaves out" : "keeps"} ${path}`, () => {
    const reason = createExcludeFilter(pattern)(path);

    assert.equal(
      reason,
      expected ? `matches the exclude pattern "${pattern}"` : null,
    );
  });
}

test("reads one pattern per line and skips comments and empty lines", () => {
  const reasonFor = createExcludeFilter(
    input("# generated documentation", "docs/**", "", "   ", "  *.txt  "),
  );

  assert.equal(reasonFor("docs/a.md"), 'matches the exclude pattern "docs/**"');
  assert.equal(reasonFor("notes/a.txt"), 'matches the exclude pattern "*.txt"');
  assert.equal(reasonFor("# generated documentation"), null);
});

test("reads an input with Windows line endings", () => {
  const reasonFor = createExcludeFilter(
    ["docs/**", "*.txt"].join(`${CARRIAGE_RETURN}\n`),
  );

  assert.equal(reasonFor("docs/a.md"), 'matches the exclude pattern "docs/**"');
  assert.equal(reasonFor("a.txt"), 'matches the exclude pattern "*.txt"');
});

test("names the default pattern when an own pattern matches as well", () => {
  const reasonFor = createExcludeFilter("dist/**");

  assert.equal(
    reasonFor("dist/index.js"),
    'matches the default exclude pattern "**/dist/**"',
  );
});

test("accepts patterns right at the limits", () => {
  const fifty = Array.from({ length: 50 }, (_, index) => `generated-${index}/`);

  assert.doesNotThrow(() => createExcludeFilter(input(...fifty)));
  assert.doesNotThrow(() => createExcludeFilter("src/*a*b.js"));
  assert.doesNotThrow(() => createExcludeFilter("packages/*/dist/*.js"));
  assert.doesNotThrow(() => createExcludeFilter("**/*a*b/**"));
  assert.doesNotThrow(() => createExcludeFilter("**/a/**/b"));
  assert.doesNotThrow(() => createExcludeFilter("a".repeat(200)));
});

// --- Patterns that cannot be used --------------------------------------------

const REJECTED = [
  ["negation", "!docs/**", /Negation with "!" is not supported/],
  ["braces", "*.{png,jpg}", /Braces and parentheses are not supported/],
  ["an extended glob", "+(a|b).js", /Braces and parentheses are not supported/],
  ["a backslash", `docs${BACKSLASH}**`, /backslash is not supported/],
  ["three stars in one name", "*a*b*c", /more than 2 "\*" wildcards/],
  ["three stars in a later directory", "src/*a*b*/x.js", /more than 2 "\*"/],
  // Stars in several directories multiply, so they are counted together.
  ["two stars in each of two directories", "*a*b/*c*d", /more than 2 "\*"/],
  ["three directories with one star each", "*/a*/b*.js", /more than 2 "\*"/],
  ["three globstars", "**/a/**/b/**", /"\*\*" more than 2 times/],
  ["a pattern that is too long", "a".repeat(201), /longer than 200 characters/],
  ["a lone slash", "/", /names no file/],
  ["a lone dot", "./", /names no file/],
];

for (const [name, pattern, expected] of REJECTED) {
  test(`rejects ${name} and says why`, () => {
    assert.throws(
      () => createExcludeFilter(input("docs/**", "# comment", pattern)),
      (error) => {
        assert.match(error.message, /^Input `exclude`, line 3: the pattern "/);
        assert.match(error.message, expected);
        return true;
      },
    );
  });
}

test("rejects more than 50 patterns", () => {
  const many = Array.from({ length: 51 }, (_, index) => `generated-${index}/`);

  assert.throws(
    () => createExcludeFilter(input(...many)),
    (error) => {
      assert.equal(
        error.message,
        "Input `exclude` has 51 patterns. At most 50 are allowed.",
      );
      return true;
    },
  );
});

test("shows a pattern in an error and in a reason as harmless text", () => {
  const odd = `docs/${ESCAPE}*`;

  const reason = createExcludeFilter(odd)(`docs/${ESCAPE}a.md`);
  assert.equal(reason, 'matches the exclude pattern "docs/\\u001b*"');

  assert.throws(
    () => createExcludeFilter(`!${odd}`),
    (error) => {
      assert.equal(error.message.includes(ESCAPE), false);
      assert.match(error.message, /\\u001b/);
      return true;
    },
  );
});

test("shortens a very long pattern in its error message", () => {
  assert.throws(
    () => createExcludeFilter("x".repeat(5000)),
    (error) => error.message.length < 400,
  );
});

// --- Running time ------------------------------------------------------------

test("stays fast for file names that are built to be slow", () => {
  // File names come from the author of the pull request. The limits on
  // wildcards exist so that these cases take milliseconds, not minutes.
  const LENGTH = 3990;
  const directories = (count, name) =>
    `${Array.from({ length: count }, () => name.repeat(Math.floor(LENGTH / count / name.length))).join("/")}!`;
  // Long names, long directories and many directories: each shape is slow
  // for a different kind of pattern.
  const paths = [
    directories(1, "a"),
    directories(2, "a"),
    directories(4, "a"),
    directories(60, "a"),
    directories(1995, "a"),
    directories(1, "ab"),
    directories(60, "ab"),
  ];
  // Every pattern uses what the limits allow: two "*" and two "**".
  const patterns = [
    "*a*a",
    "*a*b",
    "**/*a*a/**",
    "*a*a/**",
    "**/*a/*b",
    "**/*a/**/*b",
    "*a/**/*a",
    "a*a*b",
    "**/a*/**/a*/b",
    "**/*a*/**/b",
    "*a/*a/b",
    "**/a/**/*a*b",
    "**/*a*b/**/a",
    "a*/**/*a",
    "**/a*a*/**/b",
    "*ab*ab",
    "**/*ab/**/*ab/c",
    "src/**/*test*.js",
    "**/?a?a?a?a?a/**",
    "**/[ab]*[ab]*c",
  ];
  const defaults = createExcludeFilter();
  const filters = patterns.map((pattern) => createExcludeFilter(pattern));

  const started = performance.now();
  for (const path of paths) {
    defaults(path);
    for (const filter of filters) filter(path);
  }
  const elapsed = performance.now() - started;

  // Measured: a few hundred milliseconds for all 147 combinations. One
  // pattern beyond the limits alone takes several seconds.
  assert.ok(elapsed < 5000, `matching took ${Math.round(elapsed)} ms`);
});

test("rejects the patterns that were slow within the earlier limits", () => {
  // Two "*" per directory looked safe and were not: 1.4 seconds for the
  // first pattern, no result after 8 seconds for the others.
  for (const pattern of [
    "*a*a/*a*b",
    "*a*a/*a*a/*a*b",
    "**/*a*a/*a*a/*a*b",
    "*a*a/**/*a*b",
  ]) {
    assert.throws(() => createExcludeFilter(pattern), /more than 2 "\*"/);
  }
});
