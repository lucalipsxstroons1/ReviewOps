import { AiError } from "../../src/ai/error.js";
import { buildUserPrompt } from "../../src/ai/user-prompt.js";
import { lineFingerprint, textFingerprint } from "../../src/fingerprint.js";
import { fingerprintLine } from "../../src/github/marker.js";
import { loadEvent } from "./fake-context.js";
import {
  OWN_ACCOUNT,
  apiFailure,
  apiFile,
  apiThread,
  createFakeOctokit,
} from "./github-api.js";

// The runs behind the transcripts of #114: one for each way a run ends and one
// for each place where it fails. Each entry returns the options of
// `recordRun()` (see `transcript.js`), made anew on every call. The
// transcripts in `test/fixtures/transcripts/` and the tests of the result of
// `run()` use the same runs.

// --- Stand-ins -------------------------------------------------------------------

const HEAD = loadEvent().pull_request.head.sha;
const MARKER = "<!-- reviewops -->";
const INSIGHTS = {
  "insights-url": "https://insights.example.com/api/v1/ingest/review",
  "insights-secret": "s".repeat(40),
};
const INPUTS = { "github-token": "token-value", "openai-api-key": "key-value" };

/** A file with two added lines. */
const APP = apiFile("src/app.js", {
  additions: 2,
  deletions: 0,
  patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
});
const OTHER = apiFile("src/other.js", {
  additions: 1,
  deletions: 0,
  patch: "@@ -0,0 +1 @@\n+let c = 3;",
});

const earlierReview = (commit_id = HEAD) => ({
  id: 5,
  body: `${MARKER}\n\n### ReviewOps`,
  user: OWN_ACCOUNT,
  state: "COMMENTED",
  commit_id,
});

/** An inline comment of an earlier run at line 1 of `src/app.js`. */
const earlierComment = (severity = "critical") => ({
  id: 77,
  path: "src/app.js",
  body: `${MARKER}\n${fingerprintLine(
    lineFingerprint("src/app.js", "let a = 1;", ""),
    severity,
    textFingerprint("let a = 1;"),
  )}\n\ntext`,
  user: OWN_ACCOUNT,
});

const finding = (path, line, severity, title) => ({
  path,
  line,
  severity,
  category: "code-quality",
  title,
  comment: "What is wrong.",
  suggestion: "What to change.",
});

/** The result of `complete()` for an answer with these findings. */
const answerWith = (findings = []) => ({
  content: JSON.stringify({ summary: "A summary.", findings }),
  finishReason: "stop",
  usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
  model: "gpt-6-luna",
  requestId: null,
});

/** The event of the example, changed by `change`. */
const eventWith = (change) => {
  const payload = loadEvent();
  change(payload);
  return payload;
};

const closedEvent = () =>
  eventWith((payload) => {
    payload.pull_request.state = "closed";
    payload.pull_request.merged = true;
  });

const labelledEvent = () =>
  eventWith((payload) => {
    payload.pull_request.labels = [{ name: "No-AI-Review" }];
  });

// --- The ends -----------------------------------------------------------------------

export const ENDS = {
  "end-other-event": () => ({
    inputs: INPUTS,
    context: { eventName: "push" },
    octokit: createFakeOctokit([APP]),
  }),

  "end-fork-without-key": () => ({
    inputs: { ...INPUTS, "openai-api-key": "" },
    context: {
      payload: eventWith((payload) => {
        payload.pull_request.head.repo = { full_name: "someone/demo" };
      }),
    },
    octokit: createFakeOctokit([APP]),
  }),

  "end-closed-without-report": () => ({
    inputs: { ...INPUTS, "openai-api-key": "" },
    context: { payload: closedEvent() },
    octokit: createFakeOctokit([APP]),
  }),

  "end-closed-with-status-report": () => ({
    inputs: { ...INPUTS, "openai-api-key": "", ...INSIGHTS },
    context: { payload: closedEvent() },
    octokit: createFakeOctokit([APP], {
      existingReviews: [earlierReview()],
      existingComments: [earlierComment()],
      threads: [apiThread(77)],
    }),
  }),

  "end-left-out-with-open-finding-and-fail-on": () => ({
    // The runner gives `skip-label` its default; the stand-in does not.
    inputs: {
      ...INPUTS,
      "openai-api-key": "",
      "fail-on": "critical",
      "skip-label": "no-ai-review",
    },
    context: { payload: labelledEvent() },
    octokit: createFakeOctokit([APP], {
      existingReviews: [earlierReview()],
      existingComments: [earlierComment()],
      threads: [apiThread(77)],
    }),
  }),

  "end-nothing-new": () => ({
    inputs: { ...INPUTS, ...INSIGHTS },
    octokit: createFakeOctokit([APP], {
      existingReviews: [earlierReview(HEAD)],
    }),
  }),

  "end-no-files-to-review": () => ({
    inputs: INPUTS,
    octokit: createFakeOctokit([apiFile("package-lock.json")]),
  }),

  "end-no-findings-with-report": () => ({
    inputs: { ...INPUTS, ...INSIGHTS },
    octokit: createFakeOctokit([APP]),
    answer: () => answerWith(),
  }),

  "end-posted-with-other-address": () => ({
    inputs: {
      ...INPUTS,
      "openai-base-url": "https://gateway.example.com:8443/openai/v1/",
    },
    octokit: createFakeOctokit([APP]),
    answer: () => answerWith([finding("src/app.js", 2, "major", "Problem")]),
  }),

  "end-posted-with-both-reports": () => ({
    inputs: { ...INPUTS, ...INSIGHTS, "fail-on": "major" },
    octokit: createFakeOctokit([APP, OTHER], {
      existingComments: [earlierComment()],
      threads: [apiThread(77)],
    }),
    answer: () =>
      answerWith([
        finding("src/app.js", 2, "major", "A problem at line 2"),
        finding("src/app.js", 99, "minor", "A problem outside of the diff"),
      ]),
  }),

  "end-posted-after-rejection-of-the-comments": () => ({
    inputs: INPUTS,
    octokit: createFakeOctokit([APP], {
      createReview: (_, index) =>
        index === 0 ? apiFailure(422) : { status: 200, data: { id: 1001 } },
    }),
    answer: () => answerWith([finding("src/app.js", 2, "major", "Problem")]),
  }),
};

// --- The places where a run fails -----------------------------------------------

export const ERRORS = {
  "error-input-cannot-be-used": () => ({
    inputs: { ...INPUTS, "openai-model": "not a model name!" },
    octokit: createFakeOctokit([APP]),
  }),

  "error-earlier-work-cannot-be-read": () => ({
    inputs: INPUTS,
    octokit: createFakeOctokit([APP], {
      existingReviews: [earlierReview()],
      viewer: () => apiFailure(403),
    }),
  }),

  "error-every-request-to-the-model-failed": () => ({
    inputs: { ...INPUTS, ...INSIGHTS },
    octokit: createFakeOctokit([APP]),
    answer: () =>
      new AiError(
        "timeout",
        "OpenAI did not answer within 120 seconds, also after 2 retries. Run the workflow again later.",
      ),
  }),

  "error-posting-the-review-is-refused": () => ({
    inputs: { ...INPUTS, ...INSIGHTS },
    octokit: createFakeOctokit([APP], {
      createReview: () => apiFailure(403),
    }),
    answer: () => answerWith([finding("src/app.js", 2, "major", "Problem")]),
  }),

  "error-one-of-two-requests-failed": () => ({
    inputs: { ...INPUTS, ...INSIGHTS },
    octokit: createFakeOctokit([APP, OTHER]),
    planBatches: ({ files }) =>
      files.map((file) => ({
        files: [file],
        user: buildUserPrompt({ files: [file] }),
      })),
    answer: (_, index) =>
      index === 0
        ? answerWith([finding("src/app.js", 2, "major", "Problem")])
        : new AiError("server", "OpenAI could not answer (HTTP 503)."),
  }),
};

export const SCENARIOS = { ...ENDS, ...ERRORS };
