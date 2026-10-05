import * as core from "@actions/core";

// main.js is loaded at run time, not with a static import. Loading it pulls
// in every dependency, and some of them work while they load: for example,
// `@actions/github` parses the event file. A static import would let such a
// failure crash the process with a raw stack trace before any code of this
// action runs. Here it becomes a failed step with a readable message.
try {
  const { run } = await import("./main.js");
  await run();
} catch (error) {
  const reason =
    error instanceof Error ? error.message || error.name : "unknown reason";
  core.setFailed(`ReviewOps could not start: ${reason}`);

  if (error instanceof Error && error.stack) core.debug(error.stack);
}
