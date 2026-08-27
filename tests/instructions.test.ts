import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { locklessSettings, refreshInstructions, renderScopedModels } from "../src/instructions.ts";

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

  const settings = locklessSettings(SettingsManager, root, agentDir, true);

  assert.equal(settings.getRetryEnabled(), false);
  assert.equal(settings.getFollowUpMode(), "one-at-a-time");
  assert.deepEqual(readdirSync(agentDir), before);
});

test("refreshInstructions writes user state without mutating the package template", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-instructions-"));
  const home = join(root, "package");
  const configuredAgentDir = join(root, "agent");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(configuredAgentDir);
  const templatePath = join(home, "prompts", "pi-for-claude-instructions.md");
  writeFileSync(templatePath, "# Instructions\n");
  writeFileSync(join(configuredAgentDir, "settings.json"), JSON.stringify({ enabledModels: ["google/gemini-flash-latest"] }));
  const configured = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configuredAgentDir;
  try {
    const output = refreshInstructions(SettingsManager, home, root);
    assert.equal(output, join(configuredAgentDir, "pi-for-claude-instructions.md"));
    assert.match(readFileSync(output, "utf8"), /google\/gemini-flash-latest/);
    assert.equal(readFileSync(templatePath, "utf8"), "# Instructions\n");
  } finally {
    if (configured === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = configured;
  }
});
