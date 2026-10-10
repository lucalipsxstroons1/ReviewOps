import OpenAI from "openai";
import { AiError } from "./error.js";
import { acceptsTemperature, parseModel } from "./model.js";

export { AiError };

// Fixed on purpose. The SDK would take the address, the organisation and the
// project from variables of the environment if they were left out, and it
// would then send the key and the code to wherever the variable points.
const BASE_URL = "https://api.openai.com/v1";
export const TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 2;

// Low, so that a second run over the same diff gives similar findings. Only
// the models of `acceptsTemperature()` get it.
const TEMPERATURE = 0.1;

// Values that come from the answer of the API are shown only if they look
// like an identifier. Nothing else from the answer is ever written.
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;
const safe = (value) =>
  typeof value === "string" && IDENTIFIER.test(value) ? value : "unknown";

/**
 * Creates the client for the review model.
 *
 * Nothing in here writes the prompt or the answer anywhere: both contain code
 * from the pull request. The log gets numbers only.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model] Empty means the default model.
 * @param {Pick<typeof import("@actions/core"), "info" | "debug">} options.core
 * @param {typeof OpenAI} [options.OpenAIClass] Replacement for the SDK, used by tests.
 * @returns {{
 *   complete: (prompt: {
 *     system: string,
 *     user: string,
 *     responseFormat?: object,
 *     maxOutputTokens?: number,
 *   }) => Promise<{
 *     content: string,
 *     finishReason: string | null,
 *     usage: { inputTokens: number, outputTokens: number, totalTokens: number } | null,
 *     model: string,
 *     requestId: string | null,
 *   }>,
 * }}
 */
export function createAiClient({ apiKey, model, core, OpenAIClass = OpenAI }) {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new Error("The AI client needs an API key.");
  }
  const modelName = parseModel(model);

  const sdk = new OpenAIClass({
    apiKey,
    baseURL: BASE_URL,
    organization: null,
    project: null,
    logLevel: "off",
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  // One call of the client is one call of the SDK, for every model (#122).
  // A request that is repeated without `temperature` after a refusal would
  // wait for OpenAI a second time, and the time limit of the job could not
  // cover that. So `temperature` only goes to the models that take it.
  const sendTemperature = acceptsTemperature(modelName);

  function send(messages, extra) {
    return sdk.chat.completions.create({
      model: modelName,
      messages,
      ...extra,
      ...(sendTemperature ? { temperature: TEMPERATURE } : {}),
    });
  }

  return {
    async complete({ system, user, responseFormat, maxOutputTokens }) {
      if (typeof system !== "string" || typeof user !== "string") {
        throw new TypeError("The prompt needs a system text and a user text.");
      }
      if (
        maxOutputTokens !== undefined &&
        !(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0)
      ) {
        throw new TypeError(
          "The output limit must be a positive whole number.",
        );
      }
      const extra = {
        ...(responseFormat === undefined
          ? {}
          : { response_format: responseFormat }),
        ...(maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: maxOutputTokens }),
      };

      let response;
      try {
        response = await send(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          extra,
        );
      } catch (error) {
        const translated = translate(error, modelName, core);
        // Anything else is a defect of this action, not a problem of the API.
        throw translated ?? error;
      }

      return read(response, modelName, core);
    },
  };
}

/** Checks the answer and turns it into the result of the client. */
function read(response, requestedModel, core) {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  // The text of a refusal is output of the model and may repeat code from the
  // pull request, so it is neither logged nor put into the error.
  if (typeof choice?.message?.refusal === "string" && choice.message.refusal) {
    throw new AiError(
      "refusal",
      `The model "${requestedModel}" refused to review the changes, so the review is incomplete. Run the workflow again, or choose another model with the input \`openai-model\`.`,
    );
  }
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  // A cut-off or filtered answer can be empty. It is handed on with its
  // finish reason, so that the caller reports what happened and not just
  // "no text".
  const stoppedEarly =
    finishReason === "length" || finishReason === "content_filter";
  const text = typeof content === "string" ? content : "";
  if (text === "" && !stoppedEarly) {
    throw new AiError(
      "response",
      "OpenAI answered without any text. The model may have refused the request or the answer was cut off. Run the workflow again.",
    );
  }

  const model =
    safe(response.model) === "unknown" ? requestedModel : response.model;
  const requestId = IDENTIFIER.test(response._request_id ?? "")
    ? response._request_id
    : null;
  // The numbers end up in the log. They are taken only if all three are
  // whole numbers, so that nothing else from the answer gets there.
  const counts = [
    response.usage?.prompt_tokens,
    response.usage?.completion_tokens,
    response.usage?.total_tokens,
  ];
  const usage = counts.every(
    (count) => Number.isSafeInteger(count) && count >= 0,
  )
    ? {
        inputTokens: counts[0],
        outputTokens: counts[1],
        totalTokens: counts[2],
      }
    : null;

  const where = requestId ? ` (request ${requestId})` : "";
  core.info(
    usage
      ? `OpenAI answered with model ${model}: ${usage.inputTokens} input and ${usage.outputTokens} output tokens${where}.`
      : `OpenAI answered with model ${model}, without a token count${where}.`,
  );

  return {
    content: text,
    finishReason,
    usage,
    model,
    requestId,
  };
}

/**
 * Turns an error of the SDK into an AiError with its own message. Returns
 * `null` for anything that is not a problem of the API.
 */
function translate(error, model, core) {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiError(
      "timeout",
      `OpenAI did not answer within ${TIMEOUT_MS / 1000} seconds, also after ${MAX_RETRIES} retries. Run the workflow again later.`,
    );
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiError(
      "network",
      "OpenAI could not be reached. Check the network of the runner and run the workflow again.",
    );
  }
  if (error instanceof OpenAI.APIError && Number.isInteger(error.status)) {
    // Status, code, type and request ID tell what happened. The text of the
    // answer stays out: OpenAI repeats parts of the key in it.
    core.debug(
      `OpenAI error: status ${error.status}, code ${describe(error.code)}, type ${describe(error.type)}, request ${describe(error.requestID)}.`,
    );
    return byStatus(error, model);
  }
  if (error instanceof OpenAI.OpenAIError) {
    // Which kind of error it was, without anything it says.
    core.debug(`OpenAI error: ${describe(error.constructor?.name)}.`);
    return new AiError(
      "response",
      "OpenAI answered in a way that could not be read. Run the workflow again.",
    );
  }
  return null;
}

const describe = (value) =>
  value === null || value === undefined ? "none" : safe(value);

function byStatus(error, model) {
  const { status } = error;
  const http = `HTTP ${status}`;

  if (status === 401) {
    return new AiError(
      "auth",
      `OpenAI rejected the API key (${http}). Check that the repository secret \`OPENAI_API_KEY\` holds a valid key of an active project.`,
      status,
    );
  }
  if (status === 403) {
    return new AiError(
      "permission",
      `OpenAI denied the request (${http}). The key may not be allowed to use the model "${model}". Check the permissions of the key and of its project.`,
      status,
    );
  }
  if (status === 404) {
    return new AiError(
      "model",
      `OpenAI does not know the model "${model}", or the key has no access to it (${http}). Check the input \`openai-model\`.`,
      status,
    );
  }
  // A used-up quota is also an HTTP 429, but waiting does not help. OpenAI
  // names it in the type of the error. The code differs: an account without
  // credit answers with `credit_balance_exhausted`, a spending limit with
  // `insufficient_quota`. Either one counts.
  if (
    status === 429 &&
    (error.type === "insufficient_quota" || error.code === "insufficient_quota")
  ) {
    return new AiError(
      "quota",
      `The OpenAI account has no credit or quota left (${http}). Add credit, or check the billing and the spending limit of the project of the key. Running the workflow again does not help until then.`,
      status,
    );
  }
  if (status === 429) {
    return new AiError(
      "rate_limit",
      `The rate limit of OpenAI is reached (${http}), also after ${MAX_RETRIES} retries. Run the workflow again later.`,
      status,
    );
  }
  if (status >= 500) {
    return new AiError(
      "server",
      `OpenAI could not answer (${http}), also after ${MAX_RETRIES} retries. Run the workflow again later.`,
      status,
    );
  }
  // A model of the list refuses `temperature`, for example a new variant. A
  // second request without it would be a second wait, so the run fails and
  // says what to do.
  if (status === 400 && error.param === "temperature") {
    return new AiError(
      "model",
      `The model "${model}" does not accept the setting \`temperature\` that the action sends to it (${http}). Set the input \`openai-model\` to another model, such as "gpt-4.1".`,
      status,
    );
  }
  // The model cannot produce Structured Outputs. There is no fallback to a
  // weaker format on purpose: the review needs the schema. OpenAI names the
  // same parameter when it dislikes the schema itself (`invalid_json_schema`).
  // That is a defect of this action, not a setting, so it stays a plain
  // refused request.
  if (
    status === 400 &&
    error.param === "response_format" &&
    error.code !== "invalid_json_schema"
  ) {
    return new AiError(
      "model",
      `The model "${model}" does not support Structured Outputs (${http}), which the review format needs. Set the input \`openai-model\` to a model that does, such as "gpt-4o-mini" or "gpt-4.1".`,
      status,
    );
  }
  return new AiError(
    "request",
    `OpenAI rejected the request (${http}). Turn on debug logging to see status and error code.`,
    status,
  );
}
