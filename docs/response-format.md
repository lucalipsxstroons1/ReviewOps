# Response format of the model

The model does not answer with free text. The request asks for a Structured
Output (`response_format` of the type `json_schema`, `strict: true`), and the
answer is one JSON object. The schema is defined once, in `src/ai/schema.js`.
The request sends it to the model, and `parseReview()` checks the answer
against the very same object. The strict mode is not trusted: every answer is
checked locally.

The length of the answer is limited to 4096 tokens (`max_completion_tokens`).
A reasoning model counts its thinking tokens against this limit as well
(`gpt-6-luna` uses up to about 2500 of them), so the text of the answer has
room for fewer findings than the limit alone suggests. The prompt asks for
short texts for this reason.

## Fields

All fields are required. The descriptions are the ones the model gets. A test
keeps this table equal to the schema.

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | Short conclusion about the reviewed files, in the language the prompt asks for. |
| `findings` | array of objects | The findings. An empty list if nothing stands out. |
| `findings[].path` | string | Path of the file, exactly as in the request. |
| `findings[].line` | integer | Line number in the new file, one of the numbers shown in the annotated diff. |
| `findings[].severity` | string: `critical`, `major`, `minor`, `info` | How serious the problem is. |
| `findings[].category` | string: `code-quality`, `react`, `vue`, `efcore`, `security` | Focus area of the finding. If more than one fits, security wins. |
| `findings[].title` | string | Headline of the finding in one sentence. |
| `findings[].comment` | string | What the problem is and why it matters. |
| `findings[].suggestion` | string | What to change, with a short code example if needed. |

Example:

```json
{
  "summary": "One SQL query is built from user input.",
  "findings": [
    {
      "path": "src/Orders/OrderRepository.cs",
      "line": 42,
      "severity": "critical",
      "category": "security",
      "title": "SQL injection in the order search",
      "comment": "The search term is concatenated into the query text.",
      "suggestion": "Pass the term as a parameter: FromSqlInterpolated($\"... {term}\")."
    }
  ]
}
```

## What counts as an error

`parseReview()` never turns a problem into "no findings". These cases throw an
`AiError`:

| Kind | Cause |
|---|---|
| `refusal` | The model refused the request (`message.refusal`). Thrown by `complete()`. |
| `truncated` | The answer was cut off (`finish_reason: "length"`). |
| `filtered` | The content filter stopped the answer (`finish_reason: "content_filter"`). |
| `response` | The answer is not valid JSON or does not match the schema. |
| `model` | The model does not support Structured Outputs. The message points to the input `openai-model`. |

The messages name the place in the answer, for example
`findings[2].severity`, never its content: the content comes from the model and
may hold code from the pull request. The text of a refusal is not logged either.

Whether a single finding is useful (an empty text, a file that is not in the
request, a line outside the diff) is not decided here. The answer as a whole is
either valid or not.

## Checking each finding

`selectFindings()` in `src/findings.js` checks every finding of a valid answer
against the files of its own request:

| Step | Rule | Result |
|---|---|---|
| 1 | `title`, `comment` or `suggestion` holds only white space or invisible characters | left out, counted as empty |
| 2 | `path` is not exactly one of the files of the request | left out, counted as unknown path |
| 3 | Same `path`, `line` and `title` (without case and extra white space) as another finding | only the more serious one is kept |
| 4 | After an earlier review of ReviewOps: an added `line` is not one of the lines that are new since then (see below), or a finding for the text of the review is in a file without a new line or at a line the diff does not show | left out, counted as outside of the new lines |
| 5 | The line has the same fingerprint as an earlier comment or review of ReviewOps | left out, counted as commented before |
| 6 | Sorted by `severity`, `critical` first; equal severities keep their order | |
| 7 | More findings than `max-comments` (default 10) | the rest is left out and counted |
| 8 | `line` is an added line of the file | inline comment; any other line goes into the text of the review |

Steps 4 and 5 come before the limit, so a finding that was left out there never
uses up one of the `max-comments` places. On the first run, and when the whole
pull request is reviewed again, step 4 does nothing.

### Earlier reviews

A run reads the reviews and the review comments of the pull request. Only an
item that starts with the marker `<!-- reviewops -->` and whose author is a
bot counts as an item of ReviewOps. Everything else is never used and never
changed.

- The `commit_id` of the newest review of ReviewOps is the last reviewed
  commit. The run compares it with the head. Only a line that is added in the
  comparison **and** in the diff of the pull request is new. A file without a
  new line is not sent to the model again; every other file is sent with its
  whole diff.
- The whole pull request is reviewed again when there is no earlier review, when
  the comparison answers 404, `diverged` or `behind` (force-push, rebase), or
  when GitHub did not list every file of the comparison.
- The second line of every inline comment is
  `<!-- reviewops-fingerprint: <16 hex characters> severity: <severity> -->`.
  The severity lets a later run count the findings that are still open (see
  below); a line in the head of a review text has none. The fingerprint is the
  start of the SHA-256 hash over the path, the text of the line and the text of
  the line before it in the hunk (white space reduced to one space), taken from the masked diff. It stays the same when the
  line moves and changes when the text changes. A line with a known fingerprint
  gets no second comment, also not when its thread was resolved. A finding for
the text of the review carries its fingerprint in the head of the review
  text, right below the marker; only the lines directly below the marker are
  read.
- A review that left something out that a new run can fill (failed request,
  findings over `max-comments`) has the line `<!-- reviewops-incomplete -->` below the
  marker. A later run does not start at it, but at the last complete review.

The log shows only the numbers of each step, never a path or a text of a
finding.

### Open findings

The outputs `findings-count` and `critical-count`, the job summary and
`fail-on` count the open findings:

- the findings of this run after step 5, before the limit of step 7;
- the earlier inline comments of ReviewOps whose fingerprint is still the one
  of an added line of the pull request, once per fingerprint, with the most
  serious severity, unless the thread of the comment is resolved.

A finding of this run that step 5 drops counts through its earlier comment,
so nothing counts twice.
