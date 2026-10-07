// Validator for contract v1 of the insights report (docs/insights-payload.md).
// It knows exactly the fields of the contract: a missing, an extra or a
// mistyped field and every broken limit is reported with its place.

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEVERITIES = ["critical", "major", "minor", "info"];

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSafe = (value, min) => Number.isSafeInteger(value) && value >= min;
const isText = (value, pattern) =>
  typeof value === "string" && pattern.test(value);

/**
 * @param {unknown} payload
 * @returns {string[]} The violations, empty for a valid report.
 */
export function validateInsightsPayload(payload) {
  const errors = [];
  const check = (ok, place, rule) => {
    if (!ok) errors.push(`${place}: ${rule}`);
  };
  const keys = (value, expected, place) => {
    if (!isObject(value)) {
      errors.push(`${place}: must be an object`);
      return false;
    }
    const actual = Object.keys(value).sort().join(",");
    check(
      actual === [...expected].sort().join(","),
      place,
      `fields must be exactly ${expected.join(", ")}`,
    );
    return true;
  };

  const top = [
    "schemaVersion",
    "deliveryId",
    "repository",
    "prNumber",
    "commitSha",
    "runId",
    "runAttempt",
    "model",
    "tokens",
    "durationMs",
    "mode",
    "actionVersion",
    "promptVersion",
    "githubReviewId",
    "findings",
  ];
  if (!keys(payload, top, "report")) return errors;

  check(payload.schemaVersion === 1, "schemaVersion", "must be 1");
  check(
    isText(payload.deliveryId, UUID_V4),
    "deliveryId",
    "must be a lower case UUID v4",
  );
  check(
    isText(payload.repository, REPOSITORY) && payload.repository.length <= 140,
    "repository",
    "must be owner/name, at most 140 characters",
  );
  check(
    isSafe(payload.prNumber, 1),
    "prNumber",
    "must be a safe integer from 1",
  );
  check(
    isText(payload.commitSha, /^[0-9a-f]{40}$/),
    "commitSha",
    "must be 40 lower case hex characters",
  );
  check(isSafe(payload.runId, 1), "runId", "must be a safe integer from 1");
  check(
    isSafe(payload.runAttempt, 1),
    "runAttempt",
    "must be a safe integer from 1",
  );
  check(
    isText(payload.model, /^[A-Za-z0-9._:-]{1,100}$/),
    "model",
    "must match [A-Za-z0-9._:-]{1,100}",
  );
  if (keys(payload.tokens, ["input", "output", "total"], "tokens")) {
    for (const name of ["input", "output", "total"]) {
      check(
        isSafe(payload.tokens[name], 0),
        `tokens.${name}`,
        "must be a safe integer from 0",
      );
    }
  }
  check(
    isSafe(payload.durationMs, 0),
    "durationMs",
    "must be a safe integer from 0",
  );
  check(
    ["full", "incremental"].includes(payload.mode),
    "mode",
    "must be full or incremental",
  );
  check(
    isText(payload.actionVersion, /^[0-9A-Za-z.+-]{1,40}$/),
    "actionVersion",
    "must match [0-9A-Za-z.+-]{1,40}",
  );
  check(
    isSafe(payload.promptVersion, 1),
    "promptVersion",
    "must be a safe integer from 1",
  );
  check(
    payload.githubReviewId === null || isSafe(payload.githubReviewId, 1),
    "githubReviewId",
    "must be null or a safe integer from 1",
  );

  if (!Array.isArray(payload.findings)) {
    errors.push("findings: must be a list");
    return errors;
  }
  check(payload.findings.length <= 500, "findings", "at most 500 entries");
  payload.findings.forEach((finding, index) => {
    const place = `findings[${index}]`;
    const fields = [
      "severity",
      "category",
      "path",
      "line",
      "fingerprint",
      "placement",
    ];
    if (!keys(finding, fields, place)) return;
    check(
      SEVERITIES.includes(finding.severity),
      `${place}.severity`,
      "unknown severity",
    );
    check(
      isText(finding.category, /^[a-z][a-z0-9-]{0,39}$/),
      `${place}.category`,
      "must match [a-z][a-z0-9-]{0,39}",
    );
    check(
      typeof finding.path === "string" &&
        [...finding.path].length >= 1 &&
        [...finding.path].length <= 1024,
      `${place}.path`,
      "must have 1 to 1024 code points",
    );
    check(
      finding.line === null || isSafe(finding.line, 1),
      `${place}.line`,
      "must be null or a safe integer from 1",
    );
    check(
      finding.fingerprint === null ||
        isText(finding.fingerprint, /^[0-9a-f]{16}$/),
      `${place}.fingerprint`,
      "must be null or 16 lower case hex characters",
    );
    check(
      (finding.fingerprint === null) === (finding.line === null),
      `${place}.fingerprint`,
      "is null exactly when line is null",
    );
    check(
      ["inline", "body"].includes(finding.placement),
      `${place}.placement`,
      "must be inline or body",
    );
  });
  return errors;
}
