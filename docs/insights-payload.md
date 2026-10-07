# Insights report

ReviewOps Insights is a dashboard for the cost and quality of reviews across
many repositories (`lucalipsxstroons1/ReviewOps-Insights`). At the end of a
run, ReviewOps can build a report with key figures for it: token usage,
duration and the findings the review shows, with severity and category. This
file is the contract, version 1. Both sides follow it, and this repository is
its source, because it defines what leaves the runner.

`buildInsightsPayload()` in `src/insights/payload.js` builds the report, and
`sendInsightsReport()` in `src/insights/send.js` sends it (#76). The action sends
it only if the workflow sets the input `insights-url`; without it, nothing is
sent.

## Transport

- `POST` to the address from the input `insights-url`. At Insights this is
  `https://<host>/api/v1/ingest/review`.
- Body: JSON in UTF-8, at most 1 MiB, `Content-Type: application/json`.
- Header `X-ReviewOps-Signature: sha256=<hex>`: HMAC-SHA256 over the bytes of
  the body with the shared secret, 64 lower case hex characters. The secret is
  called `insights-secret` in the action and `INGEST_SECRET` at Insights. It has
  at least 32 characters, all of them visible ASCII, on both sides.
- `https` only. The action accepts `http` only for the host names `localhost`
  and `127.0.0.1`, for tests. The address has no user name or password, no
  query and no fragment.
- Redirects are not followed and not repeated: the status is the answer.
- At most three attempts of ten seconds each, every one with the same body and
  so the same `deliveryId`.

## Fields

All fields are required. Integers are safe integers (at most 2^53 − 1). The
receiver ignores unknown fields. A test keeps this table equal to the fields of
a built report.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `schemaVersion` | integer | `1` | Version of this contract |
| `deliveryId` | string | UUID version 4, lower case | Made once per run, the same for every attempt to send. The receiver stores each `deliveryId` at most once |
| `repository` | string | `owner/name`, each part `[A-Za-z0-9_.-]+`, at most 140 characters | Repository of the pull request |
| `prNumber` | integer | from 1 | Number of the pull request |
| `commitSha` | string | 40 lower case hex characters | Head commit that was reviewed |
| `runId` | integer | from 1 | `GITHUB_RUN_ID` of the workflow run |
| `runAttempt` | integer | from 1 | `GITHUB_RUN_ATTEMPT`, grows with every re-run |
| `model` | string | `[A-Za-z0-9._:-]{1,100}` | Model name from the input `openai-model` |
| `tokens` | object | | Token usage of the run |
| `tokens.input` | integer | from 0 | Input tokens, summed over the answered requests of the run |
| `tokens.output` | integer | from 0 | Output tokens, likewise |
| `tokens.total` | integer | from 0 | Total as OpenAI reports it |
| `durationMs` | integer | from 0 | Time of the action from its start to the finished report, without sending |
| `mode` | string | `full` or `incremental` | The whole pull request, or only the changes since the last review |
| `actionVersion` | string | `[0-9A-Za-z.+-]{1,40}` | Version of the action |
| `promptVersion` | integer | from 1 | `PROMPT_VERSION` of the system prompt |
| `githubReviewId` | integer or `null` | from 1 | ID of the review that was posted at GitHub; `null` if no review was posted |
| `findings` | array of objects | 0 to 500 entries | The findings the review of this run shows |
| `findings[].severity` | string | `critical`, `major`, `minor` or `info` | Severity |
| `findings[].category` | string | `[a-z][a-z0-9-]{0,39}`; today `code-quality`, `react`, `efcore`, `security` | Focus area |
| `findings[].path` | string | 1 to 1024 characters | Path of the file, as GitHub names it |
| `findings[].line` | integer or `null` | from 1 | Line in the new file; `null` if the diff does not show the line |
| `findings[].fingerprint` | string or `null` | 16 lower case hex characters | Fingerprint of the line from `lineFingerprint()`; `null` exactly when `line` is `null` |
| `findings[].placement` | string | `inline` or `body` | Inline comment at the line, or entry in the text of the review |

The length of a path is counted in UTF-16 code units (`String.length`). That is
never less than the number of Unicode code points, so a path that fits here also
fits the limit of 1024 code points. A receiver should count the same way.

## Meaning

- There is one report per run of the action that asked the model and ended
  regularly: with a posted review, or without new findings. Skipped runs (other
  event, fork or Dependabot without a key, no files to review, nothing new since
  the last review) and runs that end with an error send nothing.
- `findings` are the findings the review of this run shows, after all checks and
  after `max-comments`. Every finding is reported once, in the run that shows
  it: a line with a known fingerprint is not commented again and not reported
  again.
- A finding with a path over 1024 characters is left out, and so is everything
  after the first 500 findings. The numbers are not part of the report.
- Two findings at the same line carry the same fingerprint. Inside one report it
  is not unique.
- `tokens` count only requests that were answered with a token count. After
  failed requests the numbers are a lower bound.
- If GitHub rejected the inline comments (HTTP 422) and all findings are in the
  text of the review, `placement` is `body` everywhere. Line and fingerprint
  stay.

## What is never sent

Code and diff, texts of the model (summary, title, comment, suggestion), title,
description, author and branch of the pull request, names of people, credentials.

## Answers of the receiver

| Status | Meaning | Reaction of the action |
|---|---|---|
| `201` | Stored, body `{ "id": "…" }` | Done |
| `200` | `deliveryId` already known, body `{ "id": "…", "duplicate": true }` | Done |
| `400` | The report does not fit the contract. Body `{ "error": { "code", "message", "details" } }` with the code `VALIDATION_ERROR` or `UNSUPPORTED_SCHEMA_VERSION` | No retry, warning |
| `401` | Signature missing or wrong | No retry, warning that names `insights-secret` |
| `413` | Body too large | No retry, warning |
| `415` | `Content-Type` is not `application/json` | No retry, warning |
| `408`, `429` | Request timeout, too many requests, `Retry-After` in seconds | Retry after the pause: `Retry-After` as whole seconds, at most 10, otherwise 1 second, then 2 |
| `5xx`, network error, timeout | Temporary | Retry after the pause |
| `3xx` | Redirect | Not followed, no retry, warning with the status |
| any other status | Not part of this contract | No retry, warning |

After the third attempt a report that did not arrive ends in a warning, and the
run ends as it would have ended without Insights. A report over 1 MiB is not
sent at all.

## Versioning

- New fields and new categories come without a new version: the receiver
  ignores fields it does not know and stores categories as they come.
- Removing or renaming a field, changing a type or a meaning, or adding a
  severity raises `schemaVersion`. The receiver accepts every version it knows.

## Example

The same file is `test/fixtures/insights-review-v1.json`; a test builds this
report from a prepared run.

```json
{
  "schemaVersion": 1,
  "deliveryId": "3f2b8c1e-5d47-4a9b-8e21-7c6f0d9a4b12",
  "repository": "octo-org/shop-api",
  "prNumber": 42,
  "commitSha": "9f3c1a7b2d4e6f8091a2b3c4d5e6f708192a3b4c",
  "runId": 18234567890,
  "runAttempt": 1,
  "model": "gpt-4o-mini",
  "tokens": { "input": 18250, "output": 1140, "total": 19390 },
  "durationMs": 48211,
  "mode": "full",
  "actionVersion": "0.1.0",
  "promptVersion": 9,
  "githubReviewId": 2817345012,
  "findings": [
    {
      "severity": "critical",
      "category": "security",
      "path": "src/Orders/OrderRepository.cs",
      "line": 42,
      "fingerprint": "5a1f0c9e3b7d2a46",
      "placement": "inline"
    },
    {
      "severity": "major",
      "category": "efcore",
      "path": "src/Orders/OrderService.cs",
      "line": 118,
      "fingerprint": "c04e7a91d2b85f36",
      "placement": "inline"
    },
    {
      "severity": "minor",
      "category": "code-quality",
      "path": "src/Orders/OrderMapper.cs",
      "line": null,
      "fingerprint": null,
      "placement": "body"
    }
  ]
}
```
