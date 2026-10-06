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
 */
export function createFakeOctokit(entries = [], { createReview } = {}) {
  const calls = [];
  const reviews = [];
  const listFiles = () => {
    throw new Error("the endpoint must be passed to paginate, not called");
  };
  return {
    calls,
    reviews,
    rest: {
      pulls: {
        listFiles,
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
 * @returns {Promise<{
 *   url: string,
 *   requests: { method: string, path: string, authorization: string | undefined, body: any }[],
 *   reviews: { method: string, path: string, authorization: string | undefined, body: any }[],
 * }>} `reviews` holds the requests to post a review.
 */
export async function startGitHubApi(
  t,
  { files = [], status, message = "Not Found", headers = {}, reviews } = {},
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

    if (!/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(url.pathname)) {
      json(404, { message: "Not Found" });
      return;
    }

    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * perPage;
    const responseHeaders = {};
    if (start + perPage < files.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      responseHeaders.link = `<${address()}${next.pathname}${next.search}>; rel="next"`;
    }
    json(200, files.slice(start, start + perPage), responseHeaders);
  }

  const address = () => `http://127.0.0.1:${server.address().port}`;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { url: address(), requests, reviews: reviewRequests };
}
