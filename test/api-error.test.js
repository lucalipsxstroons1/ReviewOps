import assert from "node:assert/strict";
import { test } from "node:test";
import { describeApiError } from "../src/github/api-error.js";
import { apiFailure } from "./helpers/github-api.js";

const HINTS = { 403: "A hint for 403.", 422: "A hint for 422." };

test("uses the hint of the caller for its status", () => {
  const error = describeApiError(apiFailure(422), HINTS);

  assert.equal(
    error.message,
    "GitHub API request failed (HTTP 422). A hint for 422.",
  );
});

test("recognises a rate limit before the hint for 403", () => {
  for (const failure of [
    apiFailure(403, { headers: { "x-ratelimit-remaining": "0" } }),
    apiFailure(403, { headers: { "retry-after": "60" } }),
    apiFailure(403, { message: "You have exceeded a secondary rate limit" }),
  ]) {
    const error = describeApiError(failure, HINTS);
    assert.match(error.message, /HTTP 403\)\. The rate limit of the token/);
  }
  assert.match(
    describeApiError(apiFailure(403), HINTS).message,
    /HTTP 403\)\. A hint for 403\.$/,
  );
});

test("keeps the general hints for statuses the caller does not name", () => {
  assert.match(
    describeApiError(apiFailure(401), HINTS).message,
    /`github-token`/,
  );
  assert.match(describeApiError(apiFailure(429), HINTS).message, /rate limit/);
  assert.match(
    describeApiError(apiFailure(502), HINTS).message,
    /could not answer/,
  );
  assert.match(describeApiError(apiFailure(404)).message, /debug logging/);
});

test("names no HTTP status when the request never got an answer", () => {
  const failure = Object.assign(new Error("connect ECONNREFUSED"), {
    status: 500,
  });

  const error = describeApiError(failure, HINTS);

  assert.match(error.message, /^GitHub could not be reached\./);
  assert.equal(error.cause, failure);
});

test("passes on anything that is not an answer of the API", () => {
  const defect = new TypeError("not an API error");

  assert.equal(describeApiError(defect, HINTS), defect);
});

test("attaches the original error as the cause", () => {
  const failure = apiFailure(403);

  assert.equal(describeApiError(failure, HINTS).cause, failure);
});
