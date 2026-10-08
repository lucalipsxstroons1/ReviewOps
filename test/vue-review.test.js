import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFile, startGitHubApi } from "./helpers/github-api.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

// A pull request with a .vue file gets a comment of the category "vue" (#73).
// The action runs as its own process; GitHub and OpenAI are local stand-ins.

const PATH = "src/components/UserPicker.vue";
const PATCH = [
  "@@ -0,0 +1,6 @@",
  "+<script>",
  "+export default {",
  "+  props: { selectedId: String },",
  "+  methods: { select(id) { this.selectedId = id; } },",
  "+};",
  "+</script>",
].join("\n");

test("comments on a line of a .vue file with the category vue", async (t) => {
  const api = await startGitHubApi(t, {
    files: [apiFile(PATH, { additions: 6, deletions: 0, patch: PATCH })],
  });
  const openai = await startOpenAiApi(
    t,
    reviewCompletion([
      {
        path: PATH,
        line: 4,
        severity: "major",
        category: "vue",
        title: "A prop is assigned",
        comment: "The component assigns a value to its own prop.",
        suggestion: "Emit an event and let the parent change the value.",
      },
    ]),
  );

  const result = await startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_API_URL: api.url,
      TEST_OPENAI_URL: openai.url,
    }),
  );

  assert.equal(result.status, 0, result.output);
  // The prompt the action sent names the area.
  const system = openai.requests[0].body.messages[0].content;
  assert.ok(system.includes('(category "vue"):'));
  assert.equal(api.reviews.length, 1);
  const { comments, event } = api.reviews[0].body;
  assert.equal(event, "COMMENT");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, PATH);
  assert.equal(comments[0].line, 4);
  assert.match(comments[0].body, /vue/);
});
