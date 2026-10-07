import "./helpers/no-proxy.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import OpenAI from "openai";
import { AiError, createAiClient } from "../src/ai/client.js";
import { AiError as ErrorFromFile, isFatal } from "../src/ai/error.js";
import {
  MAX_OUTPUT_TOKENS,
  REVIEW_FORMAT,
  parseReview,
} from "../src/ai/schema.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { apiError, completion, startOpenAiApi } from "./helpers/openai-api.js";
import { fromRoot } from "./helpers/run-action.js";

// Recognisable stand-in. It must not look like a real credential.
const KEY = "TESTKEY-not-a-real-key-654321";
// OpenAI repeats the first eight and the last four characters of a wrong key.
const MASKED = `${KEY.slice(0, 8)}${"*".repeat(12)}${KEY.slice(-4)}`;
const KEY_PARTS = [KEY, MASKED, KEY.slice(0, 8), KEY.slice(-4)];

const ESCAPE = String.fromCodePoint(0x1b);
const LINE_FEED = String.fromCodePoint(0x0a);

const PROMPT = { system: "SYSTEM-MARKER-1", user: "USER-MARKER-2" };

/**
 * The real SDK, pointed at the local server and with a short timeout. The
 * client itself is not changed: it still passes its own fixed options.
 */
const sdkFor = (api, overrides = {}) =>
  class LocalSdk extends OpenAI {
    constructor(options) {
      super({ ...options, baseURL: api.url, timeout: 400, ...overrides });
    }
  };

function clientFor(api, { core = createFakeCore(), model, overrides } = {}) {
  const client = createAiClient({
    apiKey: KEY,
    model,
    core,
    OpenAIClass: sdkFor(api, overrides),
  });
  return { client, core };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected an error");
}

/** Nothing of the key may reach an error or the log, not even a part of it. */
function assertNoKey(error, core) {
  const everything = [
    error.message,
    error.stack,
    JSON.stringify(error),
    String(error.cause),
    JSON.stringify(core.calls),
  ].join("\n");
  for (const part of KEY_PARTS) {
    assert.equal(everything.includes(part), false, `"${part}" was found`);
  }
}

// --- A successful call -------------------------------------------------------

test("returns the answer of the model with its numbers", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.deepEqual(answer, {
    content: "the answer",
    finishReason: "stop",
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    model: "gpt-4o-mini-2024-07-18",
    requestId: "req_test_123",
  });
});

test("sends the prompt, the model and a low temperature with the key", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api);

  await client.complete(PROMPT);

  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.authorization, `Bearer ${KEY}`);
  assert.deepEqual(request.body, {
    model: "gpt-6-luna",
    temperature: 0.1,
    messages: [
      { role: "system", content: "SYSTEM-MARKER-1" },
      { role: "user", content: "USER-MARKER-2" },
    ],
  });
});

test("logs the model and the token usage in one line", async (t) => {
  const api = await startOpenAiApi(t);
  const { client, core } = clientFor(api);

  await client.complete(PROMPT);

  assert.deepEqual(core.messages("info"), [
    "OpenAI answered with model gpt-4o-mini-2024-07-18: 120 input and 30 output tokens (request req_test_123).",
  ]);
  assert.deepEqual(core.messages("debug"), []);
  assert.deepEqual(core.messages("warning"), []);
});

test("uses the model that was asked for", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api, { model: "gpt-4.1" });

  await client.complete(PROMPT);

  assert.equal(api.requests[0].body.model, "gpt-4.1");
});

test("uses the default model when none is given", async (t) => {
  const api = await startOpenAiApi(t);

  for (const model of [undefined, "", "  "]) {
    api.requests.length = 0;
    const { client } = clientFor(api, { model });

    await client.complete(PROMPT);

    assert.equal(api.requests[0].body.model, "gpt-6-luna");
  }
});

test("refuses a model name that cannot be one", () => {
  for (const model of ["bad model", "../etc", "gpt`4`"]) {
    assert.throws(
      () => createAiClient({ apiKey: KEY, model, core: createFakeCore() }),
      /Input `openai-model` must be the name of an OpenAI model/,
    );
  }
});

test("reports a missing token count instead of making one up", async (t) => {
  const api = await startOpenAiApi(t, completion({ usage: null }));
  const { client, core } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.equal(answer.usage, null);
  assert.deepEqual(core.messages("info"), [
    "OpenAI answered with model gpt-4o-mini-2024-07-18, without a token count (request req_test_123).",
  ]);
});

const UNUSABLE_USAGE = [
  ["only the input tokens", { prompt_tokens: 5 }],
  [
    "a token count that is text",
    { prompt_tokens: 5, completion_tokens: "many", total_tokens: 6 },
  ],
  [
    "a token count with a line break",
    {
      prompt_tokens: 5,
      completion_tokens: `1${LINE_FEED}::error::injected`,
      total_tokens: 6,
    },
  ],
  [
    "a negative token count",
    { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
  ],
  [
    "a fractional token count",
    { prompt_tokens: 1, completion_tokens: 1.5, total_tokens: 3 },
  ],
  [
    "a token count beyond any real number",
    { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1e99 },
  ],
  [
    "a token count that is null",
    { prompt_tokens: 1, completion_tokens: null, total_tokens: 1 },
  ],
  ["a usage block that is text", "lots"],
];

for (const [name, usage] of UNUSABLE_USAGE) {
  test(`reports ${name} as missing, not as a number`, async (t) => {
    const api = await startOpenAiApi(t, completion({ usage }));
    const { client, core } = clientFor(api);

    const answer = await client.complete(PROMPT);

    assert.equal(answer.usage, null);
    assert.deepEqual(core.messages("info"), [
      "OpenAI answered with model gpt-4o-mini-2024-07-18, without a token count (request req_test_123).",
    ]);
  });
}

test("reports an answer without a usage block as missing", async (t) => {
  const answer = completion();
  delete answer.body.usage;
  const api = await startOpenAiApi(t, answer);
  const { client } = clientFor(api);

  const result = await client.complete(PROMPT);

  assert.equal(result.usage, null);
});

test("accepts a token count of zero", async (t) => {
  const api = await startOpenAiApi(
    t,
    completion({
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
  const { client } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.deepEqual(answer.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("returns why the model stopped, so that a later step can check it", async (t) => {
  const api = await startOpenAiApi(t, completion({ finishReason: "length" }));
  const { client } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.equal(answer.finishReason, "length");
});

// --- Prompt and answer stay out of the log -----------------------------------

test("never writes the prompt or the answer to the log", async (t) => {
  const api = await startOpenAiApi(
    t,
    completion({ content: "ANSWER-MARKER-3" }),
  );
  const { client, core } = clientFor(api);

  await client.complete(PROMPT);

  assert.doesNotMatch(
    JSON.stringify(core.calls),
    /SYSTEM-MARKER|USER-MARKER|ANSWER-MARKER/,
  );
});

test("never writes the prompt to the log when a request fails", async (t) => {
  const failures = [
    apiError(401, { code: "invalid_api_key", message: "USER-MARKER-2" }),
    apiError(400, { code: "bad", message: "SYSTEM-MARKER-1" }),
    apiError(500, {
      message: "ANSWER-MARKER-3",
      headers: { "retry-after-ms": "5" },
    }),
  ];

  for (const answer of failures) {
    const api = await startOpenAiApi(t, answer);
    const { client, core } = clientFor(api);

    const error = await failure(client.complete(PROMPT));

    assert.doesNotMatch(
      `${error.message}${JSON.stringify(core.calls)}`,
      /SYSTEM-MARKER|USER-MARKER|ANSWER-MARKER/,
    );
  }
});

// --- A wrong key -------------------------------------------------------------

test("explains a wrong key and leaves the key out", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(401, {
      code: "invalid_api_key",
      message: `Incorrect API key provided: ${MASKED}. You can find your API key at https://platform.openai.com/account/api-keys.`,
    }),
  );
  const { client, core } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.ok(error instanceof AiError);
  assert.equal(error.kind, "auth");
  assert.equal(error.status, 401);
  assert.match(
    error.message,
    /rejected the API key \(HTTP 401\).*`OPENAI_API_KEY`/,
  );
  assertNoKey(error, core);
});

test("does not repeat a request that cannot succeed", async (t) => {
  for (const status of [401, 403, 404, 400]) {
    const api = await startOpenAiApi(t, apiError(status));
    const { client } = clientFor(api);

    await failure(client.complete(PROMPT));

    assert.equal(api.requests.length, 1, `HTTP ${status} was repeated`);
  }
});

test("keeps the key out of the error and the log for every kind of failure", async (t) => {
  const everyFailure = [
    apiError(401, { code: "invalid_api_key", message: MASKED }),
    apiError(403, { message: MASKED }),
    apiError(404, { code: "model_not_found", message: MASKED }),
    apiError(429, {
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
      message: MASKED,
    }),
    apiError(429, { message: MASKED, headers: { "retry-after-ms": "5" } }),
    apiError(500, { message: MASKED, headers: { "retry-after-ms": "5" } }),
    apiError(400, { code: MASKED, type: MASKED, message: MASKED }),
  ];

  for (const answer of everyFailure) {
    const api = await startOpenAiApi(t, answer);
    const { client, core } = clientFor(api);

    const error = await failure(client.complete(PROMPT));

    assert.ok(error instanceof AiError);
    assert.equal(error.cause, undefined);
    assertNoKey(error, core);
  }
});

// --- The other failures ------------------------------------------------------

test("says that the key may not use the model on HTTP 403", async (t) => {
  const api = await startOpenAiApi(t, apiError(403));
  const { client } = clientFor(api, { model: "gpt-4.1" });

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "permission");
  assert.match(error.message, /denied the request \(HTTP 403\).*"gpt-4\.1"/);
});

test("names the model that was not found on HTTP 404", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(404, { code: "model_not_found" }),
  );
  const { client } = clientFor(api, { model: "gpt-nope" });

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "model");
  assert.match(
    error.message,
    /does not know the model "gpt-nope".*`openai-model`/,
  );
});

// The shapes of the real API. An account without credit was observed on
// 2026-10-06: code `credit_balance_exhausted`, type `insufficient_quota`.
const QUOTA_ANSWERS = [
  [
    "an account without credit",
    { code: "credit_balance_exhausted", type: "insufficient_quota" },
  ],
  [
    "a spending limit that is reached",
    { code: "insufficient_quota", type: "insufficient_quota" },
  ],
  ["only the code", { code: "insufficient_quota", type: "other" }],
  ["only the type", { code: null, type: "insufficient_quota" }],
];

for (const [name, fields] of QUOTA_ANSWERS) {
  test(`reports ${name} as a used-up quota, not as a rate limit`, async (t) => {
    const api = await startOpenAiApi(t, apiError(429, fields));
    const { client } = clientFor(api, { overrides: { maxRetries: 0 } });

    const error = await failure(client.complete(PROMPT));

    assert.equal(error.kind, "quota");
    assert.match(
      error.message,
      /no credit or quota left.*Add credit.*spending limit/,
    );
    assert.match(error.message, /does not help until then/);
  });
}

test("does not take a rate limit for a used-up quota", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(429, {
      code: "rate_limit_exceeded",
      type: "requests",
      headers: { "retry-after-ms": "5" },
    }),
  );
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "rate_limit");
});

test("does not repeat a request when OpenAI says it is not worth it", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(429, {
      code: "insufficient_quota",
      headers: { "x-should-retry": "false" },
    }),
  );
  const { client } = clientFor(api);

  await failure(client.complete(PROMPT));

  assert.equal(api.requests.length, 1);
});

test("repeats a request on a rate limit and then reports it", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(429, {
      code: "rate_limit_exceeded",
      headers: { "retry-after-ms": "10" },
    }),
  );
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(api.requests.length, 3, "one request and two retries");
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.status, 429);
  assert.match(
    error.message,
    /rate limit of OpenAI is reached \(HTTP 429\), also after 2 retries/,
  );
});

test("repeats a request on a server error and then reports it", async (t) => {
  const api = await startOpenAiApi(t, apiError(500, { type: "server_error" }));
  const { client } = clientFor(api);

  const started = performance.now();
  const error = await failure(client.complete(PROMPT));
  const waited = performance.now() - started;

  assert.equal(api.requests.length, 3);
  assert.equal(error.kind, "server");
  assert.match(
    error.message,
    /could not answer \(HTTP 500\), also after 2 retries/,
  );
  assert.ok(
    waited >= 300,
    `no waiting between the requests (${Math.round(waited)} ms)`,
  );
});

test("returns the answer when a retry succeeds", async (t) => {
  const api = await startOpenAiApi(t, [
    apiError(500, { headers: { "retry-after-ms": "10" } }),
    apiError(503, { headers: { "retry-after-ms": "10" } }),
    completion({ content: "late answer" }),
  ]);
  const { client } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.equal(answer.content, "late answer");
  assert.equal(api.requests.length, 3);
});

test("waits as long as OpenAI asks before the next request", async (t) => {
  const api = await startOpenAiApi(t, [
    apiError(429, {
      code: "rate_limit_exceeded",
      headers: { "retry-after": "1" },
    }),
    completion(),
  ]);
  const { client } = clientFor(api);

  const started = performance.now();
  await client.complete(PROMPT);
  const waited = performance.now() - started;

  assert.equal(api.requests.length, 2);
  assert.ok(waited >= 900, `waited only ${Math.round(waited)} ms`);
});

test("reports a timeout after the retries", async (t) => {
  const api = await startOpenAiApi(t, { ...completion(), delay: 2000 });
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(api.requests.length, 3);
  assert.equal(error.kind, "timeout");
  assert.equal(error.status, null);
  assert.match(
    error.message,
    /did not answer within 120 seconds, also after 2 retries/,
  );
});

test("reports an API that cannot be reached", async () => {
  const client = createAiClient({
    apiKey: KEY,
    core: createFakeCore(),
    OpenAIClass: class extends OpenAI {
      constructor(options) {
        // Nothing listens on the discard port.
        super({ ...options, baseURL: "http://127.0.0.1:9/v1", maxRetries: 0 });
      }
    },
  });

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "network");
  assert.match(error.message, /could not be reached/);
});

test("reports any other refused request with its status", async (t) => {
  const api = await startOpenAiApi(t, apiError(422, { code: "weird" }));
  const { client, core } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "request");
  assert.equal(error.status, 422);
  assert.match(error.message, /rejected the request \(HTTP 422\)/);
  assert.deepEqual(core.messages("debug"), [
    "OpenAI error: status 422, code weird, type invalid_request_error, request req_test_123.",
  ]);
});

test("writes only status, code, type and request ID to the debug log", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(401, { code: "invalid_api_key", message: `text with ${MASKED}` }),
  );
  const { client, core } = clientFor(api);

  await failure(client.complete(PROMPT));

  assert.deepEqual(core.messages("debug"), [
    "OpenAI error: status 401, code invalid_api_key, type invalid_request_error, request req_test_123.",
  ]);
});

test("shows values of the answer in the debug log only if they look like identifiers", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(400, {
      code: `bad${LINE_FEED}::error::injected`,
      type: `${ESCAPE}[31mred`,
      headers: { "x-request-id": "not an identifier" },
    }),
  );
  const { client, core } = clientFor(api);

  await failure(client.complete(PROMPT));

  assert.deepEqual(core.messages("debug"), [
    "OpenAI error: status 400, code unknown, type unknown, request unknown.",
  ]);
});

test("does not trust the model name or the request ID of an answer", async (t) => {
  const api = await startOpenAiApi(
    t,
    completion({
      model: `evil${LINE_FEED}::error::injected`,
      requestId: "no identifier",
    }),
  );
  const { client, core } = clientFor(api, { model: "gpt-4o-mini" });

  const answer = await client.complete(PROMPT);

  assert.equal(answer.model, "gpt-4o-mini");
  assert.equal(answer.requestId, null);
  assert.deepEqual(core.messages("info"), [
    "OpenAI answered with model gpt-4o-mini: 120 input and 30 output tokens.",
  ]);
});

// --- An answer that is no answer ---------------------------------------------

const UNUSABLE_ANSWERS = [
  ["no choices", { status: 200, body: { id: "x", choices: [] } }],
  ["no message", { status: 200, body: { id: "x", choices: [{ index: 0 }] } }],
  ["no text", completion({ content: null })],
  ["an empty text", completion({ content: "" })],
  ["a text that is not a string", completion({ content: 42 })],
];

for (const [name, answer] of UNUSABLE_ANSWERS) {
  test(`treats an answer with ${name} as an error, not as an empty result`, async (t) => {
    const api = await startOpenAiApi(t, answer);
    const { client, core } = clientFor(api);

    const error = await failure(client.complete(PROMPT));

    assert.ok(error instanceof AiError);
    assert.equal(error.kind, "response");
    assert.match(error.message, /answered without any text/);
    assert.deepEqual(core.messages("info"), []);
  });
}

test("reports an answer that is not JSON as an error of the API", async (t) => {
  const api = await startOpenAiApi(t, {
    status: 200,
    headers: {},
    body: "this is not an object",
  });
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.ok(error instanceof AiError);
});

// --- temperature -------------------------------------------------------------

const TEMPERATURE_REFUSED = apiError(400, {
  code: "unsupported_parameter",
  param: "temperature",
  message:
    "Unsupported parameter: 'temperature' is not supported with this model.",
});

test("repeats the request without temperature when the model refuses it", async (t) => {
  const api = await startOpenAiApi(t, [TEMPERATURE_REFUSED, completion()]);
  const { client, core } = clientFor(api, { model: "o3-mini" });

  const answer = await client.complete(PROMPT);

  assert.equal(answer.content, "the answer");
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].body.temperature, 0.1);
  assert.equal("temperature" in api.requests[1].body, false);
  assert.deepEqual(
    api.requests.map((request) => request.body.model),
    ["o3-mini", "o3-mini"],
  );
  assert.equal(
    core.messages("info")[0],
    "The model does not accept `temperature`. The request is repeated without it.",
  );
});

test("leaves temperature out of the later requests right away", async (t) => {
  const api = await startOpenAiApi(t, [TEMPERATURE_REFUSED, completion()]);
  const { client } = clientFor(api);

  await client.complete(PROMPT);
  await client.complete(PROMPT);
  await client.complete(PROMPT);

  assert.equal(
    api.requests.length,
    4,
    "one refused request, then one per call",
  );
  assert.equal("temperature" in api.requests[3].body, false);
});

test("reports the failure when the repeated request fails as well", async (t) => {
  const api = await startOpenAiApi(t, [TEMPERATURE_REFUSED, apiError(401)]);
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "auth");
  assert.equal(api.requests.length, 2);
});

test("repeats a refused request only for temperature", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(400, { code: "unsupported_parameter", param: "max_tokens" }),
  );
  const { client } = clientFor(api);

  const error = await failure(client.complete(PROMPT));

  assert.equal(error.kind, "request");
  assert.equal(api.requests.length, 1);
});

// --- Fixed options ------------------------------------------------------------

test("lets every one of several simultaneous requests repeat without temperature", async (t) => {
  // Each request that carries a temperature is refused on its own, also the
  // ones that were already on their way when the first refusal came back.
  const api = await startOpenAiApi(t, (request) =>
    "temperature" in request.body
      ? { ...TEMPERATURE_REFUSED, delay: 50 }
      : completion(),
  );
  const { client, core } = clientFor(api);

  const answers = await Promise.all([
    client.complete(PROMPT),
    client.complete(PROMPT),
    client.complete(PROMPT),
  ]);

  assert.deepEqual(
    answers.map((answer) => answer.content),
    ["the answer", "the answer", "the answer"],
  );
  assert.equal(api.requests.length, 6, "three refused, three repeated");
  assert.deepEqual(
    core.messages("info").filter((line) => line.includes("temperature")),
    [
      "The model does not accept `temperature`. The request is repeated without it.",
    ],
    "the refusal is reported once",
  );
});

test("passes fixed options to the SDK", () => {
  const received = [];
  class Recorder {
    constructor(options) {
      received.push(options);
    }
  }

  createAiClient({
    apiKey: KEY,
    core: createFakeCore(),
    OpenAIClass: Recorder,
  });

  assert.deepEqual(received, [
    {
      apiKey: KEY,
      baseURL: "https://api.openai.com/v1",
      organization: null,
      project: null,
      logLevel: "off",
      timeout: 120_000,
      maxRetries: 2,
    },
  ]);
});

test("ignores variables of the environment that would redirect the SDK", (t) => {
  const names = [
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_LOG",
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/trap";
  process.env.OPENAI_ORG_ID = "org-from-environment";
  process.env.OPENAI_PROJECT_ID = "proj-from-environment";
  process.env.OPENAI_LOG = "debug";

  // The real SDK, not a stand-in: it is the one that reads the environment.
  const created = [];
  class Probe extends OpenAI {
    constructor(options) {
      super(options);
      created.push(this);
    }
  }
  createAiClient({ apiKey: KEY, core: createFakeCore(), OpenAIClass: Probe });

  assert.equal(created[0].baseURL, "https://api.openai.com/v1");
  assert.equal(created[0].organization, null);
  assert.equal(created[0].project, null);
});

test("does not read the key from the environment", (t) => {
  const before = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  });
  process.env.OPENAI_API_KEY = "ENVKEY-from-the-environment-000000";

  for (const apiKey of [undefined, "", 42]) {
    assert.throws(
      () => createAiClient({ apiKey, core: createFakeCore() }),
      /needs an API key/,
    );
  }
});

// --- Defects pass through -----------------------------------------------------

test("names only the kind of any other error of the SDK in the debug log", async () => {
  const errors = [
    [new OpenAI.APIUserAbortError(), "APIUserAbortError"],
    [new OpenAI.OpenAIError(`says ${MASKED} and SECRET-TEXT`), "OpenAIError"],
  ];

  for (const [thrown, className] of errors) {
    const core = createFakeCore();
    const client = createAiClient({
      apiKey: KEY,
      core,
      OpenAIClass: class {
        chat = {
          completions: {
            create: async () => {
              throw thrown;
            },
          },
        };
      },
    });

    const error = await failure(client.complete(PROMPT));

    assert.equal(error.kind, "response");
    assert.deepEqual(core.messages("debug"), [`OpenAI error: ${className}.`]);
    assertNoKey(error, core);
    assert.doesNotMatch(JSON.stringify(core.calls), /SECRET-TEXT/);
  }
});

test("passes on an error that is not a problem of the API", async () => {
  const defect = new TypeError("something in this action broke");
  const client = createAiClient({
    apiKey: KEY,
    core: createFakeCore(),
    OpenAIClass: class {
      chat = {
        completions: {
          create: async () => {
            throw defect;
          },
        },
      };
    },
  });

  await assert.rejects(client.complete(PROMPT), (error) => error === defect);
});

test("refuses a prompt that is not text", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api);

  for (const prompt of [{}, { system: "a" }, { system: 1, user: "b" }]) {
    await assert.rejects(client.complete(prompt), TypeError);
  }
  assert.equal(api.requests.length, 0);
});

// --- No real API -------------------------------------------------------------

test("only the tests decide where the SDK sends its requests", () => {
  const source = readFileSync(fromRoot("src/ai/client.js"), "utf8");

  // One fixed address, and nothing that reads one from outside.
  assert.equal(source.match(/https?:\/\//g)?.length, 1);
  assert.doesNotMatch(source, /process\.env|OPENAI_BASE_URL/);
  assert.doesNotMatch(source, /console\./);
});

// --- The review format -------------------------------------------------------

const FORMAT = {
  type: "json_schema",
  json_schema: { name: "test", strict: true, schema: { type: "object" } },
};

test("sends the response format and the output limit when they are given", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api);

  await client.complete({
    ...PROMPT,
    responseFormat: FORMAT,
    maxOutputTokens: 4096,
  });

  assert.deepEqual(api.requests[0].body, {
    model: "gpt-6-luna",
    temperature: 0.1,
    messages: [
      { role: "system", content: "SYSTEM-MARKER-1" },
      { role: "user", content: "USER-MARKER-2" },
    ],
    response_format: FORMAT,
    max_completion_tokens: 4096,
  });
});

test("keeps the response format and the output limit when the request is repeated without temperature", async (t) => {
  const api = await startOpenAiApi(t, [TEMPERATURE_REFUSED, completion()]);
  const { client } = clientFor(api, { model: "o3-mini" });

  await client.complete({
    ...PROMPT,
    responseFormat: FORMAT,
    maxOutputTokens: 100,
  });

  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[1].body.temperature, undefined);
  assert.deepEqual(api.requests[1].body.response_format, FORMAT);
  assert.equal(api.requests[1].body.max_completion_tokens, 100);
});

test("refuses an output limit that is not a positive whole number", async (t) => {
  const api = await startOpenAiApi(t);
  const { client } = clientFor(api);

  for (const maxOutputTokens of [0, -1, 1.5, "100", null, NaN]) {
    await assert.rejects(
      client.complete({ ...PROMPT, maxOutputTokens }),
      TypeError,
    );
  }
  assert.equal(api.requests.length, 0);
});

test("reports a refusal of the model without its text", async (t) => {
  const refusal = "REFUSAL-TEXT-REPEATING-CODE-FROM-THE-DIFF";
  const api = await startOpenAiApi(t, completion({ content: null, refusal }));
  const { client, core } = clientFor(api);

  const error = await failure(
    client.complete({ ...PROMPT, responseFormat: FORMAT }),
  );

  assert.ok(error instanceof AiError);
  assert.equal(error.kind, "refusal");
  assert.match(error.message, /refused to review/);
  assert.match(error.message, /openai-model/);
  const everything = [
    error.message,
    error.stack,
    JSON.stringify(error),
    JSON.stringify(core.calls),
  ].join("\n");
  assert.equal(everything.includes(refusal), false);
  assert.deepEqual(core.messages("info"), []);
});

test("takes an empty refusal for no refusal", async (t) => {
  const api = await startOpenAiApi(t, completion({ refusal: "" }));
  const { client } = clientFor(api);

  const answer = await client.complete(PROMPT);

  assert.equal(answer.content, "the answer");
});

for (const [reason, content] of [
  ["length", '{"summary": "cut o'],
  ["length", ""],
  ["length", null],
  ["content_filter", ""],
  ["content_filter", null],
]) {
  test(`hands on an answer that ended with ${reason} and ${content === null ? "no text" : content === "" ? "an empty text" : "a part of the text"}`, async (t) => {
    const api = await startOpenAiApi(
      t,
      completion({ content, finishReason: reason }),
    );
    const { client } = clientFor(api);

    const answer = await client.complete(PROMPT);

    assert.equal(answer.finishReason, reason);
    assert.equal(answer.content, content ?? "");
  });
}

test("a cut-off answer is an error of the review, not an empty review", async (t) => {
  const api = await startOpenAiApi(
    t,
    completion({
      content: '{"summary": "s", "findings": [',
      finishReason: "length",
    }),
  );
  const { client } = clientFor(api);

  const answer = await client.complete({
    ...PROMPT,
    responseFormat: REVIEW_FORMAT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const error = await failure(
    Promise.resolve().then(() => parseReview(answer)),
  );

  assert.equal(error.kind, "truncated");
});

test("an answer of the test server passes the review check", async (t) => {
  const review = {
    summary: "s",
    findings: [
      {
        path: "a.js",
        line: 1,
        severity: "info",
        category: "code-quality",
        title: "t",
        comment: "c",
        suggestion: "s",
      },
    ],
  };
  const api = await startOpenAiApi(
    t,
    completion({ content: JSON.stringify(review) }),
  );
  const { client } = clientFor(api);

  const answer = await client.complete({
    ...PROMPT,
    responseFormat: REVIEW_FORMAT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  assert.deepEqual(parseReview(answer), review);
});

// The shape of this answer is what the API is known to send for a model
// without Structured Outputs (an HTTP 400 for the parameter
// `response_format`). It is not yet measured against the real API.
const NO_STRUCTURED_OUTPUTS = apiError(400, {
  param: "response_format",
  message:
    "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
});

test("explains a model without Structured Outputs and points to the input", async (t) => {
  const api = await startOpenAiApi(t, NO_STRUCTURED_OUTPUTS);
  const { client } = clientFor(api, { model: "gpt-3.5-turbo" });

  const error = await failure(
    client.complete({ ...PROMPT, responseFormat: FORMAT }),
  );

  assert.ok(error instanceof AiError);
  assert.equal(error.kind, "model");
  assert.equal(error.status, 400);
  assert.match(
    error.message,
    /"gpt-3\.5-turbo" does not support Structured Outputs/,
  );
  assert.match(error.message, /`openai-model`/);
  assert.equal(api.requests.length, 1);
});

test("does not repeat a request for a model without Structured Outputs", async (t) => {
  const api = await startOpenAiApi(t, NO_STRUCTURED_OUTPUTS);
  const { client } = clientFor(api);

  await failure(client.complete({ ...PROMPT, responseFormat: FORMAT }));

  assert.equal(api.requests.length, 1);
});

test("reports the missing Structured Outputs also after temperature was refused", async (t) => {
  const api = await startOpenAiApi(t, [
    TEMPERATURE_REFUSED,
    NO_STRUCTURED_OUTPUTS,
  ]);
  const { client } = clientFor(api);

  const error = await failure(
    client.complete({ ...PROMPT, responseFormat: FORMAT }),
  );

  assert.equal(error.kind, "model");
  assert.equal(api.requests.length, 2);
});

test("does not take a defect of the schema for a model without Structured Outputs", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(400, {
      param: "response_format",
      code: "invalid_json_schema",
      message: "Invalid schema for response_format 'review': a reason.",
    }),
  );
  const { client, core } = clientFor(api);

  const error = await failure(
    client.complete({ ...PROMPT, responseFormat: FORMAT }),
  );

  assert.equal(error.kind, "request");
  assert.equal(error.status, 400);
  assert.doesNotMatch(error.message, /Structured Outputs/);
  assert.match(core.messages("debug").join("\n"), /code invalid_json_schema/);
});

test("takes any other refused parameter for a refused request", async (t) => {
  const api = await startOpenAiApi(
    t,
    apiError(400, { param: "max_completion_tokens" }),
  );
  const { client } = clientFor(api);

  const error = await failure(
    client.complete({ ...PROMPT, responseFormat: FORMAT }),
  );

  assert.equal(error.kind, "request");
});

test("the error class lives in its own file, without the SDK", () => {
  assert.equal(AiError, ErrorFromFile);
  const source = readFileSync(fromRoot("src/ai/error.js"), "utf8");
  assert.equal(/^import /m.test(source), false);
  const schemaSource = ["src/ai/schema.js", "src/ai/json-schema.js"].map(
    (file) => readFileSync(fromRoot(file), "utf8"),
  );
  for (const text of schemaSource) {
    assert.equal(/from "openai"|client\.js/.test(text), false);
  }
});

test("names the errors after which no further request is worth a try", () => {
  for (const kind of ["auth", "permission", "model", "quota"]) {
    assert.equal(isFatal(new AiError(kind, "x")), true, kind);
  }
  for (const kind of [
    "rate_limit",
    "server",
    "timeout",
    "network",
    "request",
    "response",
    "refusal",
    "truncated",
    "filtered",
  ]) {
    assert.equal(isFatal(new AiError(kind, "x")), false, kind);
  }
  assert.equal(isFatal(new Error("auth")), false);
  assert.equal(isFatal({ kind: "auth" }), false);
});
