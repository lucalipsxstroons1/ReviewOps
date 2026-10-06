# Response format of the model

The model does not answer with free text. The request asks for a Structured
Output (`response_format` of the type `json_schema`, `strict: true`), and the
answer is one JSON object. The schema is defined once, in `src/ai/schema.js`.
The request sends it to the model, and `parseReview()` checks the answer
against the very same object. The strict mode is not trusted: every answer is
checked locally.

The length of the answer is limited to 4096 tokens (`max_completion_tokens`).
That is enough for about 30 findings.

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
| `findings[].category` | string: `code-quality`, `react`, `efcore`, `security` | Focus area of the finding. If more than one fits, security wins. |
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
| 4 | Sorted by `severity`, `critical` first; equal severities keep their order | |
| 5 | More findings than `max-comments` (default 10) | the rest is left out and counted |
| 6 | `line` is an added line of the file | inline comment; any other line goes into the text of the review |

The log shows only the numbers of each step, never a path or a text of a
finding.
