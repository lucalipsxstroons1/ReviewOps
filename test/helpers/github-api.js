import { createServer } from "node:http";

/**
 * One entry of GitHub's "list pull request files" response.
 *
 * @param {string} filename
 * @param {object} [fields] Fields that differ from an ordinary modified file.
 */
export function apiFile(filename, fields = {}) {
  const entry = {
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...fields,
  };
  return { changes: entry.additions + entry.deletions, ...entry };
}

/**
 * One review thread in the shape of GitHub's GraphQL answer.
 *
 * @param {number} id The id of the comment that opened the thread.
 * @param {boolean} [isResolved]
 */
export const apiThread = (id, isResolved = false) => ({
  isResolved,
  comments: { nodes: [{ databaseId: id }] },
});

// Threads per page of the GraphQL answer, like GitHub.
const THREAD_PAGE_SIZE = 100;

/**
 * The answer to the query for the review threads: one page of `threads`,
 * starting at the cursor, which is the index of the first thread as text.
 */
export function threadPage(threads, cursor) {
  const start = cursor ? Number(cursor.replace("cursor-", "")) : 0;
  const end = start + THREAD_PAGE_SIZE;
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: {
            hasNextPage: end < threads.length,
            endCursor: end < threads.length ? `cursor-${end}` : null,
          },
          nodes: threads.slice(start, end),
        },
      },
    },
  };
}

/** `count` ordinary modified files with distinct names. */
export const apiFiles = (count) =>
  Array.from({ length: count }, (_, index) => apiFile(`src/file-${index}.js`));

/**
 * Stand-in for an Octokit client that returns fixed entries and records how
 * it was called.
 *
 * @param {object[]} [entries] The changed files of the pull request.
 * @param {object} [options]
 * @param {(parameters: object, index: number) => object} [options.createReview]
 *   Answers a request to post a review: the response, or an error to throw.
 *   Without it, every review is created with a new id.
 * @param {object[]} [options.existingReviews] Reviews already on the pull
 *   request, in the shape of GitHub's answer.
 * @param {object[]} [options.existingComments] Review comments already on
 *   the pull request.
 * @param {(parameters: object) => { status: string, files?: object[] } | Error} [options.compare]
 *   Answers a comparison of two commits. Without it, every comparison fails
 *   with 404. The files are served in pages like GitHub does.
 * @param {object[] | ((variables: object) => object | Error)} [options.threads]
 *   The review threads (`apiThread()`), served in pages, or a function that
 *   answers the GraphQL query. Without it, the pull request has no threads.
 */
export function createFakeOctokit(
  entries = [],
  {
    createReview,
    existingReviews = [],
    existingComments = [],
    compare,
    threads = [],
  } = {},
) {
  const calls = [];
  const reviews = [];
  const comparisons = [];
  const queries = [];
  const endpointCalled = () => {
    throw new Error("the endpoint must be passed to paginate, not called");
  };
  // Distinct functions: paginate() tells the endpoints apart by identity.
  const listFiles = () => endpointCalled();
  const listReviews = () => endpointCalled();
  const listReviewComments = () => endpointCalled();
  return {
    calls,
    reviews,
    comparisons,
    queries,
    graphql: async (query, variables) => {
      queries.push({ query, variables });
      const answer =
        typeof threads === "function"
          ? threads(variables)
          : threadPage(threads, variables.cursor);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    rest: {
      repos: {
        compareCommitsWithBasehead: async (parameters) => {
          comparisons.push(parameters);
          const answer = compare
            ? compare(parameters)
            : apiFailure(404, { message: "Not Found" });
          if (answer instanceof Error) throw answer;
          const { files = [], ...rest } = answer;
          const start = (parameters.page - 1) * parameters.per_page;
          return {
            status: 200,
            data: {
              ...rest,
              files: files.slice(start, start + parameters.per_page),
            },
          };
        },
      },
      pulls: {
        listFiles,
        listReviews,
        listReviewComments,
        createReview: async (parameters) => {
          const index = reviews.length;
          reviews.push(parameters);
          const answer = createReview
            ? createReview(parameters, index)
            : { status: 200, data: { id: 1000 + index } };
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    },
    paginate: async (endpoint, parameters) => {
      calls.push({ endpoint, parameters });
      if (endpoint === listReviews) return existingReviews;
      if (endpoint === listReviewComments) return existingComments;
      return entries;
    },
  };
}

/** An error in the shape Octokit throws for an answer of the API. */
export function apiFailure(status, { headers = {}, message = "Failure" } = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers },
  });
}

/**
 * Starts a local HTTP server that answers like GitHub's endpoints for the
 * files of a pull request, including pagination, and for posting a review.
 * It is stopped when the test ends. No request leaves this machine.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [answer]
 * @param {object[]} [answer.files] Entries to serve, split into pages.
 * @param {number} [answer.status] Answer every request with this error status.
 * @param {string} [answer.message] Message of the error answer.
 * @param {Record<string, string>} [answer.headers] Extra headers of the error answer.
 * @param {(request: object, index: number) => { status: number, body?: object }} [answer.reviews]
 *   Answers a request to post a review. Without it, every review is
 *   created with a new id.
 * @param {object[]} [answer.existingReviews] Reviews already on the pull
 *   request, split into pages.
 * @param {object[]} [answer.existingComments] Review comments already on the
 *   pull request, split into pages.
 * @param {(basehead: string) => { status: number, body?: object }} [answer.compare]
 *   Answers a comparison of two commits, given as "base...head". Without it,
 *   every comparison fails with 404. The files of the body are split into
 *   pages.
 * @param {object[] | ((variables: object) => { status: number, body: object })} [answer.threads]
 *   The review threads (`apiThread()`) for the GraphQL query, served in pages,
 *   or a function that answers the query. Without it, there are no threads.
 * @returns {Promise<{
 *   url: string,
 *   requests: { method: string, path: string, authorization: string | undefined, body: any }[],
 *   reviews: { method: string, path: string, authorization: string | undefined, body: any }[],
 * }>} `reviews` holds the requests to post a review.
 */
export async function startGitHubApi(
  t,
  {
    files = [],
    status,
    message = "Not Found",
    headers = {},
    reviews,
    existingReviews = [],
    existingComments = [],
    compare,
    threads = [],
  } = {},
) {
  const requests = [];
  const reviewRequests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => answerRequest(request, response, text));
  });

  function answerRequest(request, response, text) {
    const url = new URL(request.url, "http://localhost");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Recorded as null.
    }
    const recorded = {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      body,
    };
    requests.push(recorded);
    const json = (code, payload, extra = {}) => {
      response.writeHead(code, {
        "content-type": "application/json",
        ...extra,
      });
      response.end(JSON.stringify(payload));
    };

    if (status) {
      json(status, { message }, headers);
      return;
    }

    if (
      request.method === "POST" &&
      /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(url.pathname)
    ) {
      const index = reviewRequests.length;
      reviewRequests.push(recorded);
      const chosen = reviews
        ? reviews(recorded, index)
        : { status: 200, body: { id: 1000 + index } };
      json(chosen.status, chosen.body ?? { message: "Validation Failed" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/graphql") {
      const variables = body?.variables ?? {};
      const chosen =
        typeof threads === "function"
          ? threads(variables)
          : {
              status: 200,
              body: { data: threadPage(threads, variables.cursor) },
            };
      json(chosen.status, chosen.body);
      return;
    }

    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * perPage;

    const compared = /^\/repos\/[^/]+\/[^/]+\/compare\/([^/]+)$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && compared) {
      const chosen = compare
        ? compare(decodeURIComponent(compared[1]))
        : { status: 404 };
      const { files: compareFiles = [], ...rest } = chosen.body ?? {
        message: "Not Found",
      };
      json(chosen.status, {
        ...rest,
        ...(chosen.status === 200
          ? { files: compareFiles.slice(start, start + perPage) }
          : {}),
      });
      return;
    }

    const lists = [
      [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/, files],
      [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/, existingReviews],
      [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/, existingComments],
    ];
    const list = lists.find(([pattern]) => pattern.test(url.pathname));
    if (request.method !== "GET" || !list) {
      json(404, { message: "Not Found" });
      return;
    }

    const entries = list[1];
    const responseHeaders = {};
    if (start + perPage < entries.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      responseHeaders.link = `<${address()}${next.pathname}${next.search}>; rel="next"`;
    }
    json(200, entries.slice(start, start + perPage), responseHeaders);
  }

  const address = () => `http://127.0.0.1:${server.address().port}`;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { url: address(), requests, reviews: reviewRequests };
}
