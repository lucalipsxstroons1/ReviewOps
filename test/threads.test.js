import "./helpers/no-proxy.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getOctokit } from "@actions/github";
import {
  ThreadsUnavailableError,
  readResolvedComments,
} from "../src/github/threads.js";
import {
  apiFailure,
  apiThread,
  createFakeOctokit,
  startGitHubApi,
  threadPage,
} from "./helpers/github-api.js";
import { TOKEN } from "./helpers/run-action.js";

const PULL_REQUEST = { owner: "octo-org", repo: "demo", pullNumber: 42 };

const read = (options) =>
  readResolvedComments(createFakeOctokit([], options), PULL_REQUEST);

// --- With a mocked Octokit ---------------------------------------------------

test("returns the ids of the comments that opened a resolved thread", async () => {
  const resolved = await read({
    threads: [apiThread(1, true), apiThread(2, false), apiThread(3, true)],
  });
  assert.deepEqual([...resolved].sort(), [1, 3]);
});

test("returns nothing for a pull request without threads", async () => {
  assert.equal((await read({ threads: [] })).size, 0);
});

test("asks for the threads of the right pull request", async () => {
  const octokit = createFakeOctokit([], { threads: [] });
  await readResolvedComments(octokit, PULL_REQUEST);

  const [{ query, variables }] = octokit.queries;
  assert.match(query, /reviewThreads\(first: 100, after: \$cursor\)/);
  assert.match(query, /isResolved/);
  assert.deepEqual(variables, {
    owner: "octo-org",
    repo: "demo",
    number: 42,
    cursor: null,
  });
});

test("reads every page of threads", async () => {
  const threads = Array.from({ length: 250 }, (_, index) =>
    apiThread(index + 1, index % 2 === 0),
  );
  const octokit = createFakeOctokit([], { threads });
  const resolved = await readResolvedComments(octokit, PULL_REQUEST);

  assert.equal(octokit.queries.length, 3);
  assert.deepEqual(
    octokit.queries.map(({ variables }) => variables.cursor),
    [null, "cursor-100", "cursor-200"],
  );
  assert.equal(resolved.size, 125);
  assert.ok(resolved.has(249));
  assert.ok(!resolved.has(250));
});

test("stops after 30 pages: the threads after that count as not resolved", async () => {
  const threads = Array.from({ length: 3100 }, (_, index) =>
    apiThread(index + 1, true),
  );
  const octokit = createFakeOctokit([], { threads });
  const resolved = await readResolvedComments(octokit, PULL_REQUEST);

  assert.equal(octokit.queries.length, 30);
  assert.equal(resolved.size, 3000);
  assert.ok(!resolved.has(3001));
});

test("counts a thread as resolved only with exactly true and a valid id", async () => {
  const resolved = await read({
    threads: [
      { isResolved: "true", comments: { nodes: [{ databaseId: 1 }] } },
      { isResolved: 1, comments: { nodes: [{ databaseId: 2 }] } },
      { isResolved: true, comments: { nodes: [{ databaseId: "3" }] } },
      { isResolved: true, comments: { nodes: [{ databaseId: 0 }] } },
      { isResolved: true, comments: { nodes: [{ databaseId: -4 }] } },
      { isResolved: true, comments: { nodes: [{ databaseId: 5.5 }] } },
      { isResolved: true, comments: { nodes: [] } },
      { isResolved: true },
      null,
      apiThread(6, true),
    ],
  });
  assert.deepEqual([...resolved], [6]);
});

test("stops reading at an answer of another shape", async () => {
  for (const answer of [
    null,
    {},
    { repository: null },
    { repository: { pullRequest: null } },
    { repository: { pullRequest: { reviewThreads: { nodes: "no" } } } },
  ]) {
    const resolved = await read({ threads: () => answer });
    assert.equal(resolved.size, 0);
  }
});

test("does not send back a cursor that does not look like one", async () => {
  for (const endCursor of [null, "", "a b", "<x>", "x".repeat(201), 42]) {
    const octokit = createFakeOctokit([], {
      threads: () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor },
              nodes: [apiThread(1, true)],
            },
          },
        },
      }),
    });
    const resolved = await readResolvedComments(octokit, PULL_REQUEST);
    assert.equal(octokit.queries.length, 1);
    assert.deepEqual([...resolved], [1]);
  }
});

test("fails with a hint when the token may not read the threads", async () => {
  const failure = apiFailure(403);
  await assert.rejects(
    read({ threads: () => failure }),
    (error) =>
      error instanceof ThreadsUnavailableError &&
      error.cause === failure &&
      /HTTP 403/.test(error.message) &&
      /`pull-requests` permission/.test(error.message),
  );
});

test("names a missing connection as such", async () => {
  // Octokit reports a failed connection as status 500 without a response.
  const failure = Object.assign(new Error("connect ECONNREFUSED"), {
    status: 500,
  });
  await assert.rejects(
    read({ threads: () => failure }),
    (error) =>
      error instanceof ThreadsUnavailableError &&
      /could not be reached/.test(error.message),
  );
});

test("fails with its own message when GitHub answers with GraphQL errors", async () => {
  const failure = Object.assign(new Error("Could not resolve octo-org/demo"), {
    name: "GraphqlResponseError",
    errors: [{ message: "Could not resolve octo-org/demo" }],
  });
  await assert.rejects(read({ threads: () => failure }), (error) => {
    assert.ok(error instanceof ThreadsUnavailableError);
    assert.match(error.message, /query for the review threads/);
    assert.doesNotMatch(error.message, /debug logging/);
    assert.doesNotMatch(error.message, /octo-org/);
    return true;
  });
});

test("passes on anything that is not an answer of the API", async () => {
  const defect = new TypeError("broken");
  await assert.rejects(
    read({ threads: () => defect }),
    (error) => error === defect,
  );
});

// --- With the real Octokit and the local test server ------------------------

test("sends the query to the GraphQL endpoint of the API address", async (t) => {
  const api = await startGitHubApi(t, {
    threads: [apiThread(7, true), apiThread(8, false)],
  });
  const resolved = await readResolvedComments(
    getOctokit(TOKEN, { baseUrl: api.url }),
    PULL_REQUEST,
  );

  assert.deepEqual([...resolved], [7]);
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/graphql");
  assert.equal(request.authorization, `token ${TOKEN}`);
  assert.equal(request.body.variables.number, 42);
});

test("reads the pages from the local test server", async (t) => {
  const threads = Array.from({ length: 150 }, (_, index) =>
    apiThread(index + 1, true),
  );
  const api = await startGitHubApi(t, { threads });
  const resolved = await readResolvedComments(
    getOctokit(TOKEN, { baseUrl: api.url }),
    PULL_REQUEST,
  );

  assert.equal(resolved.size, 150);
  assert.equal(api.requests.length, 2);
});

test("turns GraphQL errors of the server into its own message", async (t) => {
  const api = await startGitHubApi(t, {
    threads: () => ({
      status: 200,
      body: { data: null, errors: [{ message: "Something about octo-org" }] },
    }),
  });
  await assert.rejects(
    readResolvedComments(getOctokit(TOKEN, { baseUrl: api.url }), PULL_REQUEST),
    (error) =>
      /query for the review threads/.test(error.message) &&
      !/octo-org/.test(error.message),
  );
});

test("fails with a hint when the server answers 403", async (t) => {
  const api = await startGitHubApi(t, {
    threads: () => ({ status: 403, body: { message: "Forbidden" } }),
  });
  await assert.rejects(
    readResolvedComments(getOctokit(TOKEN, { baseUrl: api.url }), PULL_REQUEST),
    /`pull-requests` permission/,
  );
});

test("threadPage() serves the threads in pages of 100", () => {
  const threads = Array.from({ length: 120 }, (_, index) => apiThread(index));
  const first = threadPage(threads, null).repository.pullRequest.reviewThreads;
  assert.equal(first.nodes.length, 100);
  assert.deepEqual(first.pageInfo, {
    hasNextPage: true,
    endCursor: "cursor-100",
  });
});
