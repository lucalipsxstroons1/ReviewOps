// Loaded with `--import` into every process test, before the action starts.
//
// The address of OpenAI is fixed in the action on purpose, so a test cannot
// point it elsewhere through the environment. This module does it from the
// outside instead: requests to OpenAI go to the local stand-in named in
// TEST_OPENAI_URL, or to a port where nothing listens. No request of a test
// reaches OpenAI, and the test key never leaves this machine.

const OPENAI = "https://api.openai.com/v1";

// Nothing listens on the discard port.
const UNREACHABLE = "http://127.0.0.1:9/v1";

const target = process.env.TEST_OPENAI_URL || UNREACHABLE;
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url =
    input instanceof Request ? input.url : String(input?.href ?? input);
  if (!url.startsWith(`${OPENAI}/`)) return realFetch(input, init);

  const redirected = target + url.slice(OPENAI.length);
  return input instanceof Request
    ? realFetch(new Request(redirected, input), init)
    : realFetch(redirected, init);
};
