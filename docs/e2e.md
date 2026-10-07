# End-to-end test with demo pull requests

Result of the test in #20 on 2026-10-06. It checks the whole chain: trigger,
diff, model, inline comment at the right line. The action ran from this
repository (`uses: ./`) at `main` of commit `cf47712` (with #17 to #19).

## Setup

- `e2e/base` is `main` plus a clean demo app under `demo/` (`demo/react/`,
  `demo/dotnet/`) and `openai-model: gpt-4.1` in `reviewops.yml`. `e2e/base-mini`
  is the same with `gpt-4o-mini`. Both branches only exist for this test and
  are never merged. `main` holds no demo code.
- Each case is a branch `e2e/<case>` with exactly one built-in defect. The
  test pull requests were closed without merging, the branches stay.
- The demo code was written for this test and is not taken from `eval/cases`,
  so the test does not only check what the prompt was tuned on.
- The expected place of each defect was fixed before the first run. "Right
  line" means that the inline comment sits exactly there.
- Prompt, demo code and thresholds were not changed to make a case pass.

## Focus cases with `gpt-4.1` (reference model)

| Case | Pull request | Expected place | Comment at | Right line | Other findings | Job time | Tokens (in / out) |
|---|---|---|---|---|---|---|---|
| React hook, `useEffect` without `customerId` | [#62](https://github.com/lucalipsxstroons1/ReviewOps/pull/62) | `demo/react/OrderList.jsx:42` | `:42` | yes | none | 10 s | 1779 / 134 |
| EF Core, N+1 query | [#63](https://github.com/lucalipsxstroons1/ReviewOps/pull/63) | `demo/dotnet/Repositories/OrderRepository.cs:36` (the query in the loop) | `:31` (the opening brace of the method) | **no** | none | 10 s | 1802 / 209 |
| Security, action without `[Authorize]` | [#64](https://github.com/lucalipsxstroons1/ReviewOps/pull/64) | `demo/dotnet/Controllers/OrdersController.cs:27` (the signature of `Export`) | `:26` (the `[HttpGet]` line of `Export`) | **no**, one line above | none | 10 s | 1760 / 148 |

All three reviews name the built-in defect: a missing dependency, one query
per customer, and a missing authorization on `Export` while the neighbour
action has it (rated `critical`). Two of the three comments sit at the head
of the affected method and not at the line named in advance. The comment of
the security case is one line above the expected one, and it is the first line
of the added action. The comment of the N+1 case is five lines above the
query. These two cases therefore **do not meet the strict reading** of the
acceptance criterion "at the right line". The cause was open at the time and
is investigated in [#70](https://github.com/lucalipsxstroons1/ReviewOps/issues/70),
see [Follow-up in #70](#follow-up-in-70-2026-10-07) below; neither the prompt
nor the demo code was adapted here.

## Workflow runs

The workflow ran through (conclusion `success`) in every run, for `opened`
(the first run of each pull request) and for `synchronize` (every later push).

| Event | Run | Pull request |
|---|---|---|
| opened | [37469045197](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469045197) | #62 React |
| opened | [37469052478](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469052478) | #63 EF Core |
| opened | [37469057623](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469057623) | #64 Security |
| opened | [37469169928](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469169928) | #65 React (mini) |
| opened | [37469175609](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469175609) | #66 EF Core (mini) |
| opened | [37469180018](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469180018) | #67 Security (mini) |
| opened | [37469184169](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469184169) | #68 lockfile only |
| opened | [37469193076](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469193076) | #69 large |
| synchronize | [37469393158](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469393158) | #69 large (renamed file) |
| synchronize | [37469464622](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469464622) | #62 second push, no code change |
| synchronize | [37469471212](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469471212) | #65 second push, no code change |
| synchronize | [37469544397](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469544397) | #62 second push, second defect |
| synchronize | [37469544777](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37469544777) | #65 second push, second defect |

## Special cases (`gpt-4.1`)

| Case | Pull request | Result | Notice or warning |
|---|---|---|---|
| Only a lockfile changes | [#68](https://github.com/lucalipsxstroons1/ReviewOps/pull/68) | green, no request to the model, no review | notice: `ReviewOps found no files to review in this pull request. The log lists the skipped files.`, log line: `Skipped demo/react/package-lock.json: matches the default exclude pattern "package-lock.json".` |
| Very large pull request: 60 small files and one file with 77311 characters | [#69](https://github.com/lucalipsxstroons1/ReviewOps/pull/69) | green, one request with 50 files (4082 / 32 tokens, 9 s), no finding, so no review | warnings: `Files larger than one request to the model: 1. They are not reviewed. One request holds at most 50000 characters.` and `Files left out because of the limits: 10. They are not reviewed. The limits are max-files: 50 and max-diff-chars: 200000.` |
| Second push without a code change | #62, #65 | green, no request to the model, no review | notice: `ReviewOps found no new lines to review since commit 67ddb71…. A green run does not mean that new changes were reviewed.` (6 s) |
| Second push with a second defect | #62 | green, exactly one new inline comment (`demo/react/OrderList.jsx:55`), the comment at `:42` stays and is not repeated (the model reported it again, `1 outside of the new lines` dropped it) | review [5428926769](https://github.com/lucalipsxstroons1/ReviewOps/pull/62#pullrequestreview-5428926769), 1927 / 232 tokens, 11 s |

A flaw in the first setup of the large case: the big file was named
`rows.js` and came 61st in GitHub's order, so `max-files` removed it before
the size check could. The first run (`7458af9`) therefore only showed the
`max-files` warning. Renaming it to `a-rows.js` (second run, `0777f8f`)
brought it under the first 50 and showed the warning about one request. Both
limits are shown above. A file that is too large for one request does not
count for `max-files`, so after it left, the 50 small files fit.

## `gpt-4o-mini` as groundwork for #41

The same three cases ran as separate pull requests against `e2e/base-mini`
(same head branches, same diffs). This does not count for the acceptance
criteria.

| Case | Pull request | Found | Comment at | Right line | Job time | Tokens (in / out) |
|---|---|---|---|---|---|---|
| React hook | [#65](https://github.com/lucalipsxstroons1/ReviewOps/pull/65) | yes, `major` | `:42` | yes | 18 s | 1779 / 131 |
| EF Core, N+1 | [#66](https://github.com/lucalipsxstroons1/ReviewOps/pull/66) | yes, `major` | `:36` | yes | 10 s | 1802 / 198 |
| Security, missing `[Authorize]` | [#67](https://github.com/lucalipsxstroons1/ReviewOps/pull/67) | **no**, 0 findings | none | no | 11 s | 1760 / 21 |
| React hook, second defect (second push) | #65 | **no**, 0 findings | none | no | 11 s | 1927 / 20 |

Observations, one run per case, so no statistic:

- `gpt-4o-mini` found the N+1 case and put the comment exactly at the query
  line, where `gpt-4.1` commented on the method head. Earlier the evaluation
  suggested that `gpt-4o-mini` does not find N+1 (`CLAUDE.md`). This
  single run does not confirm that, but one run does not refute it either.
- It missed the missing authorization and the second hook defect, both with
  the neighbour or the pattern visible in the diff. For a review tool, a
  missed defect without a hint is the worse failure than a line that is off
  by a few lines.
- Cost per review lies in the same range for both models in tokens (about
  1800 in, 20 to 230 out for these small diffs). The price per token is not
  part of this test.
- Job time is 6 to 18 seconds, almost all of it the model request.

## Findings of this test

- The comment line of `gpt-4.1` for method-level defects is the head of the
  method, not the line of the defect (cases #63 and #64). The
  [follow-up in #70](#follow-up-in-70-2026-10-07) found that neither the
  prompt nor the annotated diff causes this.
- The special cases and both events (`opened`, `synchronize`) work as
  specified, each with a clear notice or warning.

## Follow-up in #70 (2026-10-07)

Question: does the default model `gpt-6-luna` put the comment at the line of a
method-level defect, and what caused the deviation of `gpt-4.1` above? No new
run was made. The series of [#41](https://github.com/lucalipsxstroons1/ReviewOps/issues/41)
ran the same three demo pull requests (#62 to #64) with the same prompt
(version 9) and the same diffs, three runs per model. The lines below are read
from the logs of those runs.

| Case | Right place | `gpt-4.1` (1 run, above) | `gpt-6-luna` (3 runs) | `gpt-6.1-sol` (3 runs) | `gpt-4o-mini` (3 runs) |
|---|---|---|---|---|---|
| EF Core, N+1 query (#63), `OrderRepository.cs` | `:36` | `:31` | `:36` in 3 of 3 | `:36` in 3 of 3 | `:36` in 3 of 3 |
| Security, missing `[Authorize]` (#64), `OrdersController.cs` | `:26` or `:27` | `:26` | `:26` in 3 of 3 | `:26` in 3 of 3 | not found, 0 of 3 |

Runs: [37597484540](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37597484540)
(`gpt-6-luna`), [37598858902](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37598858902)
(`gpt-6.1-sol`), [37597189072](https://github.com/lucalipsxstroons1/ReviewOps/actions/runs/37597189072)
(`gpt-4o-mini`).

- **Cause.** Neither the prompt nor the annotated diff. Three models with the
  same prompt and the same diff put the N+1 comment at the query line (`:36`).
  The `:31` of `gpt-4.1` is one run of a model that is no longer the default,
  and one run cannot be told apart from variance. It stays as an observation;
  `gpt-4.1` was not measured again and remains the reference model of the
  evaluation.
- **Expectation widened afterwards.** For the authorization case both `:26`
  (the `[HttpGet]` line of the new action) and `:27` (the signature) count as
  the right place: `[Authorize]` belongs there, and all models that find the
  defect choose `:26`. The expectation of the first table, fixed before the
  runs, was too narrow. That table stays as it was.
- **Extra comment.** `gpt-6-luna` also commented on `:33` (the query for the
  customers, rated `minor`) in all three N+1 runs. This is an additional
  comment, not a miss of the defect.
- **`gpt-4o-mini`** does not find the missing authorization, so there is no
  line to judge. That was one reason for the choice of the model in #41.
- Nothing under `src/` or `eval/` changed, and `PROMPT_VERSION` stays 9.
