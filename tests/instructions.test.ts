import assert from "node:assert/strict";
import test from "node:test";

import { renderScopedModels } from "../src/instructions.ts";

test("renderScopedModels inserts and replaces Pi's saved model scope", () => {
  const first = renderScopedModels("# Instructions\n", ["openai-codex/gpt-5.6-sol", "google/gemini-flash-latest"]);
  assert.match(first, /- `openai-codex\/gpt-5\.6-sol`/);
  assert.match(first, /- `google\/gemini-flash-latest`/);

  const second = renderScopedModels(first, ["openai-codex/gpt-5.7-sol"]);
  assert.doesNotMatch(second, /gpt-5\.6-sol/);
  assert.equal(second.match(/## Pi scoped models/g)?.length, 1);
});

test("renderScopedModels rejects a malformed managed section", () => {
  assert.throws(() => renderScopedModels("<!-- pi-scoped-models:start -->\n", []), /Malformed Pi scoped-models section/);
});
