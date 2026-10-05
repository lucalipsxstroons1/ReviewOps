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
 */
export function createFakeOctokit(entries = []) {
  const calls = [];
  const listFiles = () => {
    throw new Error("the endpoint must be passed to paginate, not called");
  };
  return {
    calls,
    rest: { pulls: { listFiles } },
    paginate: async (endpoint, parameters) => {
      calls.push({ endpoint, parameters });
      return entries;
    },
  };
}

/**
 * Starts a local HTTP server that answers like GitHub's endpoint for the
 * files of a pull request, including pagination. It is stopped when the
 * test ends. No request leaves this machine.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [answer]
 * @param {object[]} [answer.files] Entries to serve, split into pages.
 * @param {number} [answer.status] Answer every request with this error status.
 * @param {string} [answer.message] Message of the error answer.
 * @param {Record<string, string>} [answer.headers] Extra headers of the error answer.
 * @returns {Promise<{ url: string, requests: { path: string, authorization: string | undefined }[] }>}
 */
export async function startGitHubApi(
  t,
  { files = [], status, message = "Not Found", headers = {} } = {},
) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });

    if (status) {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify({ message }));
      return;
    }

    if (!/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(url.pathname)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }

    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * perPage;
    const responseHeaders = { "content-type": "application/json" };
    if (start + perPage < files.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      responseHeaders.link = `<${address()}${next.pathname}${next.search}>; rel="next"`;
    }
    response.writeHead(200, responseHeaders);
    response.end(JSON.stringify(files.slice(start, start + perPage)));
  });

  const address = () => `http://127.0.0.1:${server.address().port}`;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { url: address(), requests };
}
