import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { fromRoot } from "./helpers/run-action.js";

// What has to be true before the release workflow is started: the notes, the
// README and SECURITY.md fit the version that is about to be released
// (docs/release.md). The workflow itself is tested in workflow.test.js.

const { version } = JSON.parse(readFileSync(fromRoot("package.json"), "utf8"));
const major = version.split(".")[0];
const read = (path) => readFileSync(fromRoot(path), "utf8");

test("the version is a plain MAJOR.MINOR.PATCH", () => {
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
});

test("there are release notes for the version in package.json", () => {
  const file = `docs/releases/v${version}.md`;

  assert.ok(existsSync(fromRoot(file)), `${file} is missing`);
  const notes = read(file);
  assert.match(
    notes,
    new RegExp(`^## ReviewOps v${version.replaceAll(".", "\\.")}\\n`),
  );
  assert.ok(notes.length > 500, "the notes are too short to be real");
  assert.doesNotMatch(notes, /\b(TODO|TBD)\b/);
});

test("the README example follows the major tag of this version", () => {
  assert.match(
    read("README.md"),
    new RegExp(`uses: lucalipsxstroons1/ReviewOps@v${major}\\n`),
  );
});

test("SECURITY.md names the supported version", () => {
  assert.ok(
    read("SECURITY.md").includes(
      `Only the latest release of the current major version (v${major}) is supported.`,
    ),
  );
});

test("the checklist names the check the ruleset has to require", () => {
  const ci = parse(read(".github/workflows/ci.yml"));
  const checkName = ci.jobs.check.name;

  assert.ok(read("docs/release.md").includes(`\`${checkName}\``));
});

test("the checklist and the notes link to each other's rules", () => {
  assert.ok(read("docs/release.md").includes(`docs/releases/v<version>.md`));
  assert.ok(read(`docs/releases/v${version}.md`).includes("docs/release.md"));
});

test("the ruleset file for main matches the rules of the release checklist", () => {
  const ruleset = JSON.parse(read("docs/ruleset-main.json"));
  const ci = parse(read(".github/workflows/ci.yml"));
  const byType = Object.fromEntries(
    ruleset.rules.map((rule) => [rule.type, rule]),
  );

  assert.equal(ruleset.target, "branch");
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  // The one bypass of the real ruleset: the repository role with the ID 2.
  assert.deepEqual(ruleset.bypass_actors, [
    { actor_id: 2, actor_type: "RepositoryRole", bypass_mode: "always" },
  ]);
  // Deleting and force-pushing are blocked.
  assert.ok("deletion" in byType && "non_fast_forward" in byType);
  // A pull request is required, and nobody has to approve their own.
  assert.equal(
    byType.pull_request.parameters.required_approving_review_count,
    0,
  );
  // Only squash merges: one commit on main for every issue.
  assert.deepEqual(byType.pull_request.parameters.allowed_merge_methods, [
    "squash",
  ]);
  // The check of ci.yml is required (from GitHub Actions), and the one of
  // ReviewOps is not.
  assert.deepEqual(
    byType.required_status_checks.parameters.required_status_checks,
    [{ context: ci.jobs.check.name, integration_id: 15368 }],
  );
});

test("the smoke test in the checklist uses the first workflow of the README", () => {
  const checklist = read("docs/release.md");

  assert.match(checklist, /## Smoke test/);
  assert.match(checklist, /first workflow of the \[README\]/);
  assert.match(checklist, /useEffect/);
  assert.match(checklist, /\}, \[\]\);/);
});
