# Releases

ReviewOps is released with a GitHub Release and a moving major tag. Users pin to `v1`, or to the full commit SHA of a release.

**Status:** everything for the release of `v1.0.0` is prepared (version, notes, workflow, settings, smoke test), but the release has not been made. It is started by the maintainer when wanted, with the steps below. Until then, `@v1` does not resolve.

## Versions

The version follows [SemVer](https://semver.org). It stands in three places that have to agree: `version` in `package.json` (and the lock file), `ACTION_VERSION` in `src/version.js`, and the release notes in `docs/releases/v<version>.md`. A test keeps the first two equal, and another one checks that there are notes for the current version.

- **Patch:** a bug fix. Behaviour only changes where it was wrong.
- **Minor:** a new input, or new behaviour that can be switched off.
- **Major:** a new default model, an input that is removed or renamed, or an output that changes its meaning. A new default model changes the cost and the findings of every user, so it is never a patch or a minor release.

Pre-releases (`-rc`) are not supported by the release workflow.

## Tags

- `v<version>`, for example `v1.0.0`, is made once and never moved.
- `v<major>`, for example `v1`, is moved to the commit of every release of that major version. That is what `uses: lucalipsxstroons1/ReviewOps@v1` follows.

No ruleset covers the tags: the release workflow has to be able to move the major tag.

## Checklist

Before the release:

- [ ] The issues the release depends on are closed. The release does not wait for every other open issue: later fixes follow as patch or minor releases.
- [ ] The CI on `main` is green.
- [ ] The README is up to date. Its test (`test/readme.test.js`) is green, so the tables of inputs and outputs and the default model match the code.
- [ ] The version is raised (`npm version <version> --no-git-tag-version`, and `ACTION_VERSION` in `src/version.js`), and `dist/` is rebuilt (`npm run build`).
- [ ] The release notes `docs/releases/v<version>.md` are written, in English, and the notes mention a changed default model.
- [ ] The change is merged through a pull request.

Then start the workflow: **Actions**, **Release**, **Run workflow**, on the branch `main`. It runs only on `main`, and it:

1. reads the version from `package.json` and checks it against `ACTION_VERSION`, that the tag `v<version>` does not exist yet, and that the release notes exist,
2. runs `npm ci`, the lint, the tests and the build, and stops when the build changes `dist/`,
3. creates the release `v<version>` with the notes, and with it the tag, on the commit of the run,
4. moves the major tag `v<major>` to the same commit,
5. checks through the API that both tags point at that commit.

After the release:

- [ ] Open the release page and check the notes and the two tags.
- [ ] Run the smoke test: the workflow of the README, unchanged with `@v<major>`, in a fresh public repository, on a pull request with a known defect. Add the links under "Release history".

## If a run fails

The workflow checks everything before it makes anything, so a failure in the first steps changes nothing: fix the cause and start it again.

If it fails after the release was created, do not start it again: it stops at "the tag exists already". Open the release page and the tags instead.

- The release `v<version>` exists, but the major tag is missing or stands at another commit: set it by hand to the commit of the release (`<sha>`):

  ```
  gh api --method PATCH repos/lucalipsxstroons1/ReviewOps/git/refs/tags/v<major> -f sha=<sha> -F force=true
  ```

  If the tag does not exist yet, create it with `--method POST repos/lucalipsxstroons1/ReviewOps/git/refs -f ref=refs/tags/v<major> -f sha=<sha>`.
- The release was created with a wrong note: edit it on the release page. Do not delete the tag `v<version>`: it is never moved.

## Repository settings

Set by the maintainer, both done.

- **Ruleset for `main`** (set on 07.10.2026 as "Main Protect"): [ruleset-main.json](ruleset-main.json) is the file of it, and Settings, Rules, Rulesets, New ruleset, Import a ruleset sets it up again, for example in another repository. It blocks deletion and force-push, requires a pull request before merging with 0 approvals (nobody can approve their own pull request), allows only squash merges, and requires the status check `Lint, test and build` (the job of `ci.yml`). The check of ReviewOps itself is not required: an outage at OpenAI would block every merge. The repository role with the ID 2 can bypass the rules, so the maintainer can push in an emergency; there is no ruleset for the tags. A test keeps the file and `ci.yml` equal.
- **Private vulnerability reporting** (Settings, Security, Private vulnerability reporting): on since 07.10.2026. `SECURITY.md` points to it.

## Smoke test

It shows that the action works when another repository uses it by the tag. Do it after every major release, and after a minor one that changes the workflow.

1. Create a fresh public repository, for example `ReviewOps-smoke`, with a `main` branch.
2. Store the repository secret `OPENAI_API_KEY` (Settings, Secrets and variables, Actions). The key has to be allowed to use the default model.
3. Add the first workflow of the [README](../README.md) unchanged as `.github/workflows/reviewops.yml`, on `main`.
4. Open a pull request that adds `src/OrderCount.jsx` with a known defect, a `useEffect` that reads `customerId` but has an empty dependency array:

   ```jsx
   import { useEffect, useState } from "react";

   export function OrderCount({ customerId }) {
     const [count, setCount] = useState(0);

     useEffect(() => {
       fetch(`/api/customers/${customerId}/orders/count`)
         .then((response) => response.json())
         .then((data) => setCount(data.count));
     }, []);

     return <span>{count} open orders</span>;
   }
   ```

5. The run of the workflow is green, and the pull request gets one review with an inline comment at the effect that names the missing dependency. A model can miss it in a single run: push an empty commit and look again before you call it a failure.
6. Add the links to the run and to the review under "Release history".

## Release history

| Version | Date | Commit | Smoke test |
|---|---|---|---|
| v1.0.0 | not released yet | | |
