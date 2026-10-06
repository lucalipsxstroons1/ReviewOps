import { createServer } from "node:http";

/** The answer of the chat endpoint when everything works. */
export function completion({
  content = "the answer",
  model = "gpt-4o-mini-2024-07-18",
  finishReason = "stop",
  usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  requestId = "req_test_123",
  extra = {},
} = {}) {
  return {
    status: 200,
    headers: { "x-request-id": requestId },
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: { role: "assistant", content, refusal: null },
        },
      ],
      usage,
      ...extra,
    },
  };
}

/** The answer of OpenAI for a failed request, in the shape of the real API. */
export function apiError(
  status,
  {
    code = null,
    message = "A message from OpenAI.",
    type = "invalid_request_error",
    param = null,
    headers = {},
  } = {},
) {
  return {
    status,
    headers: { "x-request-id": "req_test_123", ...headers },
    body: { error: { message, type, code, param } },
  };
}

/**
 * Starts a local HTTP server that answers like the chat endpoint of OpenAI.
 * It is stopped when the test ends. No request leaves this machine.
 *
 * @param {import("node:test").TestContext} t
 * @param {object | object[] | ((request: object, index: number) => object)} answer
 *   What to answer: one answer for every request, a list (the last one is
 *   repeated) or a function of the request and its number. An answer is
 *   `{ status, body, headers, delay }` as `completion()` and `apiError()`
 *   build it; `delay` holds it back for that many milliseconds.
 * @returns {Promise<{ url: string, requests: { method: string, path: string, authorization: string | undefined, body: any }[] }>}
 */
export async function startOpenAiApi(t, answer = completion()) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Recorded as null.
      }
      const index = requests.length;
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });

      const chosen =
        typeof answer === "function"
          ? answer(requests[index], index)
          : Array.isArray(answer)
            ? answer[Math.min(index, answer.length - 1)]
            : answer;

      const send = () => {
        response.writeHead(chosen.status, {
          "content-type": "application/json",
          ...chosen.headers,
        });
        response.end(JSON.stringify(chosen.body));
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

  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
