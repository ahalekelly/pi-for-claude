import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { locklessSettings, renderScopedModels } from "../src/instructions.ts";

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

test("locklessSettings reads global and project settings without filesystem writes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-settings-"));
  const agentDir = join(root, "agent");
  const projectSettings = join(root, ".pi");
  mkdirSync(agentDir);
  mkdirSync(projectSettings);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true }, followUpMode: "one-at-a-time" }));
  writeFileSync(join(projectSettings, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const before = readdirSync(agentDir);

  const settings = locklessSettings(root, agentDir);

  assert.equal(settings.getRetryEnabled(), false);
  assert.equal(settings.getFollowUpMode(), "one-at-a-time");
  assert.deepEqual(readdirSync(agentDir), before);
});
