import "./helpers/no-proxy.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getOctokit } from "@actions/github";
import {
  IdentityUnavailableError,
  readOwnAccountId,
} from "../src/github/identity.js";
import {
  OWN_ACCOUNT,
  apiFailure,
  createFakeOctokit,
  startGitHubApi,
} from "./helpers/github-api.js";
import { TOKEN } from "./helpers/run-action.js";

const read = (options) => readOwnAccountId(createFakeOctokit([], options));

// --- With a mocked Octokit ---------------------------------------------------

test("returns the id of the account of the token", async () => {
  assert.equal(await read({}), OWN_ACCOUNT.id);
  assert.equal(await read({ viewer: 7 }), 7);
});

test("asks for the id of the viewer and nothing else", async () => {
  const octokit = createFakeOctokit([]);
  await readOwnAccountId(octokit);

  assert.equal(octokit.viewerQueries.length, 1);
  assert.match(octokit.viewerQueries[0].query, /viewer\s*\{\s*databaseId\s*\}/);
  assert.equal(octokit.queries.length, 0);
});

for (const [name, answer] of [
  ["text", { viewer: { databaseId: "41898282" } }],
  ["0", { viewer: { databaseId: 0 } }],
  ["a negative number", { viewer: { databaseId: -5 } }],
  ["a fraction", { viewer: { databaseId: 1.5 } }],
  ["a number too large to be exact", { viewer: { databaseId: 2 ** 60 } }],
  ["null", { viewer: { databaseId: null } }],
  ["missing", { viewer: {} }],
  ["not in an answer without a viewer", {}],
  ["not in an answer without data", null],
]) {
  test(`fails with its own message when the id is ${name}`, async () => {
    await assert.rejects(read({ viewer: () => answer }), (error) => {
      assert.ok(error instanceof IdentityUnavailableError);
      assert.match(error.message, /account of the token/);
      assert.match(error.message, /Run the workflow again/);
      return true;
    });
  });
}

test("fails with the status and a hint when GitHub answers 403", async () => {
  await assert.rejects(
    read({ viewer: () => apiFailure(403) }),
    (error) =>
      error instanceof IdentityUnavailableError &&
      /HTTP 403/.test(error.message) &&
      /`github-token`/.test(error.message),
  );
});

test("names the rate limit instead of a hint", async () => {
  await assert.rejects(
    read({ viewer: () => apiFailure(429) }),
    (error) =>
      error instanceof IdentityUnavailableError &&
      /rate limit/.test(error.message),
  );
});

test("fails when the network does not answer", async () => {
  const failure = Object.assign(new Error("socket hang up"), { status: 500 });
  await assert.rejects(
    read({ viewer: () => failure }),
    (error) =>
      error instanceof IdentityUnavailableError &&
      /could not be reached/.test(error.message),
  );
});

test("fails with its own message when GitHub answers with GraphQL errors", async () => {
  const failure = Object.assign(new Error("Something about octo-org"), {
    name: "GraphqlResponseError",
    errors: [{ message: "Something about octo-org" }],
  });
  await assert.rejects(read({ viewer: () => failure }), (error) => {
    assert.ok(error instanceof IdentityUnavailableError);
    assert.doesNotMatch(error.message, /octo-org/);
    return true;
  });
});

test("passes on anything that is not an answer of the API", async () => {
  const defect = new TypeError("broken");
  await assert.rejects(
    read({ viewer: () => defect }),
    (error) => error === defect,
  );
});

// --- Against a local server --------------------------------------------------

test("reads the id from a server", async (t) => {
  const api = await startGitHubApi(t, { viewer: 123 });
  const id = await readOwnAccountId(getOctokit(TOKEN, { baseUrl: api.url }));

  assert.equal(id, 123);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].path, "/graphql");
});

test("turns GraphQL errors of the server into its own message", async (t) => {
  const api = await startGitHubApi(t, {
    viewer: () => ({
      status: 200,
      body: { data: null, errors: [{ message: "Something about octo-org" }] },
    }),
  });
  await assert.rejects(
    readOwnAccountId(getOctokit(TOKEN, { baseUrl: api.url })),
    (error) =>
      error instanceof IdentityUnavailableError &&
      !/octo-org/.test(error.message),
  );
});

test("fails with a hint when the server answers 403", async (t) => {
  const api = await startGitHubApi(t, {
    viewer: () => ({ status: 403, body: { message: "Forbidden" } }),
  });
  await assert.rejects(
    readOwnAccountId(getOctokit(TOKEN, { baseUrl: api.url })),
    /`github-token`/,
  );
});
