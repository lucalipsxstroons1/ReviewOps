import { parseAddress } from "../address.js";
import { printable } from "../printable.js";

// The same value is written into action.yml. A test keeps them equal.
export const DEFAULT_MODEL = "gpt-6-luna";

// Letters, digits and the characters that model names use, such as
// "gpt-4.1", "o3-mini" or the fine-tuning name "ft:gpt-4o-mini:org::id".
// The name ends up in a request and in messages, so nothing else is allowed.
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Reads the `openai-model` input. An empty value means the default: it is
 * usually a variable of the workflow that was not set.
 *
 * @param {string} [value] The value as the workflow passed it.
 * @returns {string}
 * @throws {Error} When the value is not the name of a model.
 */
export function parseModel(value = "") {
  const name = String(value).trim();
  if (name === "") return DEFAULT_MODEL;

  if (!MODEL_NAME.test(name)) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`openai-model\` must be the name of an OpenAI model (letters, digits, ".", "-", "_" and ":", at most 100 characters), but is "${printable(name)}".`,
    );
  }
  return name;
}

// The models that take `temperature`: `gpt-4.1` and `gpt-4o` with their
// variants (`-mini`, `-nano`, a date) and as a fine-tune (`ft:`). Both
// families ran with a temperature of 0.1 in the measurements of this project.
// Every other model gets none: the reasoning models (the default among them)
// refuse it, and an unknown model is not asked in a way that could be refused.
// The name goes on with `-` or `:`, or it ends, so that `gpt-4.10` or
// `gpt-4omni` are not taken for these.
const TAKES_TEMPERATURE = /^(?:ft:)?(?:gpt-4\.1|gpt-4o)(?:[-:]|$)/;

/**
 * Whether the request to a model carries `temperature`. A model that refuses
 * it would need a second request, and a second request is a second wait for
 * an answer that may never come (#122): so the list names the models that
 * take it, and the client sends one request for every model.
 *
 * @param {unknown} model The name of the model, as `parseModel()` returns it.
 * @returns {boolean}
 */
export function acceptsTemperature(model) {
  return typeof model === "string" && TAKES_TEMPERATURE.test(model);
}

/** The address of the API of OpenAI, the default of `openai-base-url`. */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Reads the `openai-base-url` input (#40). An empty value means the address of
 * OpenAI: it is usually a variable of the workflow that was not set.
 *
 * The key and the code of the pull request go to this address, so it is
 * checked before the first request with the rules of every address the action
 * sends something to (`parseAddress()`): `https`, `http` only for the machine
 * of the runner, no user name or password, no query, no fragment. The messages
 * name the rule and never the address.
 *
 * Only this input sets the address. The environment of the runner does not:
 * the SDK would take `OPENAI_BASE_URL` from it, which is why the address is
 * passed on to the SDK explicitly.
 *
 * @param {string} [value] The value as the workflow passed it.
 * @returns {{ url: string, host: string, isDefault: boolean }} The address
 *   without a slash at the end, its host (with the port) for the log, and
 *   whether it is the address of OpenAI.
 * @throws {Error} When the value cannot be used as an address.
 */
export function parseBaseUrl(value = "") {
  const text = String(value).trim();
  if (text === "") return describeBaseUrl(DEFAULT_BASE_URL);

  const address = parseAddress(text, {
    input: "openai-base-url",
    example: "https://my-resource.openai.azure.com/openai/v1",
    secretInput: "openai-api-key",
  });
  return describeBaseUrl(address.href.replace(/\/+$/, ""));
}

function describeBaseUrl(url) {
  const { host } = new URL(url);
  return { url, host, isDefault: url === DEFAULT_BASE_URL };
}
