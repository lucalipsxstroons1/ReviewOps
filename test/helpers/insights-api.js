import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/** A secret for the tests. It is long enough and looks like no credential. */
export const INSIGHTS_TEST_SECRET =
  "TESTSECRET-not-a-real-secret-0123456789abcdef";

/** The header value Insights expects: HMAC-SHA256 over the bytes of the body. */
export const insightsSignature = (secret, body) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** An answer that never comes, for the test of the time limit. */
export const NO_ANSWER = Object.freeze({ hang: true });

/** An answer with an error in the form Insights uses. */
export const insightsError = (status, code, headers = {}) => ({
  status,
  headers,
  body: { error: { code, message: "A message from the test server." } },
});

/**
 * Starts a local HTTP server that answers like the endpoint of ReviewOps
 * Insights. It is stopped when the test ends. No request leaves this machine.
 *
 * It recomputes the signature over the raw bytes it received, so a test shows
 * that both sides agree byte by byte, and it records every request.
 *
 * Without an `answer` it behaves like Insights: `401` for a wrong signature,
 * `415` for another content type, `201` for a new `deliveryId` and `200` with
 * `duplicate: true` for a known one.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options]
 * @param {string} [options.secret] The secret the signature is checked with.
 * @param {object | object[] | ((request: object, index: number) => object)} [options.answer]
 *   One answer for every request, a list (the last one is repeated) or a
 *   function of the request and its number. An answer is
 *   `{ status, body, headers, delay }`; `delay` holds it back for that many
 *   milliseconds, `text` replaces the JSON body with text as it is, and
 *   `NO_ANSWER` never answers.
 * @returns {Promise<{
 *   url: string,
 *   secret: string,
 *   requests: {
 *     method: string,
 *     path: string,
 *     headers: Record<string, string | string[] | undefined>,
 *     raw: Buffer,
 *     body: any,
 *     signatureValid: boolean,
 *   }[],
 * }>}
 */
export async function startInsightsApi(
  t,
  { secret = INSIGHTS_TEST_SECRET, answer } = {},
) {
  const requests = [];
  const known = new Set();

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // Recorded as null.
      }
      const expected = Buffer.from(insightsSignature(secret, raw));
      const given = Buffer.from(request.headers["x-reviewops-signature"] ?? "");
      const signatureValid =
        given.length === expected.length && timingSafeEqual(given, expected);

      const index = requests.length;
      const recorded = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        raw,
        body,
        signatureValid,
      };
      requests.push(recorded);

      const chosen = choose(answer, recorded, index, known);
      if (chosen.hang) return;

      const send = () => {
        response.writeHead(chosen.status, {
          "content-type": "application/json",
          ...chosen.headers,
        });
        // `text` is sent as it is, for an answer that is not JSON.
        response.end(
          chosen.text ??
            (chosen.body === undefined ? "" : JSON.stringify(chosen.body)),
        );
      };
      if (chosen.delay) setTimeout(send, chosen.delay);
      else send();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );

  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1/ingest/review`,
    secret,
    requests,
  };
}

function choose(answer, request, index, known) {
  if (typeof answer === "function") return answer(request, index);
  if (Array.isArray(answer)) return answer[Math.min(index, answer.length - 1)];
  if (answer) return answer;

  if (!request.signatureValid) return insightsError(401, "UNAUTHORIZED");
  if (!/^application\/json\b/.test(request.headers["content-type"] ?? "")) {
    return insightsError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const id = request.body?.deliveryId;
  if (known.has(id)) return { status: 200, body: { id, duplicate: true } };
  known.add(id);
  return { status: 201, body: { id } };
}
