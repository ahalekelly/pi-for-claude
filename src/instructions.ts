import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";

import { agentDir } from "./agent-paths.ts";

type SettingsManagerClass = typeof SettingsManager;

const start = "<!-- pi-scoped-models:start -->";
const end = "<!-- pi-scoped-models:end -->";

export function renderScopedModels(instructions: string, scopedModels: readonly string[]): string {
  const models = scopedModels.length === 0 ? "Pi has no saved model scope." : scopedModels.map((model) => `- \`${model}\``).join("\n");
  const section = `${start}\n## Pi scoped models\n\nThis list is generated from Pi's saved \`/scoped-models\` configuration.\n\n${models}\n${end}`;
  const startIndex = instructions.indexOf(start);
  const endIndex = instructions.indexOf(end);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) throw new Error("Malformed Pi scoped-models section");
  if (startIndex === -1) return `${instructions.trimEnd()}\n\n${section}\n`;
  return `${instructions.slice(0, startIndex)}${section}${instructions.slice(endIndex + end.length)}`;
}

export function locklessSettings(Settings: SettingsManagerClass, cwd: string, configuredAgentDir: string, projectTrusted: boolean): SettingsManager {
  const values: Record<"global" | "project", string | undefined> = {
    global: existsSync(join(configuredAgentDir, "settings.json")) ? readFileSync(join(configuredAgentDir, "settings.json"), "utf8") : undefined,
    project: existsSync(join(cwd, ".pi", "settings.json")) ? readFileSync(join(cwd, ".pi", "settings.json"), "utf8") : undefined,
  };
  const storage = {
    withLock(scope: "global" | "project", update: (current: string | undefined) => string | undefined) {
      values[scope] = update(values[scope]) ?? values[scope];
    },
  };
  return Settings.fromStorage(storage, { projectTrusted });
}

export function refreshInstructions(Settings: SettingsManagerClass, home: string, cwd: string): void {
  const settings = locklessSettings(Settings, cwd, agentDir(), false);
  const error = settings.drainErrors().find(({ scope }) => scope === "global");
  if (error) throw error.error;
  const instructionsPath = join(home, "prompts", "pi-for-claude-instructions.md");
  const current = readFileSync(instructionsPath, "utf8");
  const updated = renderScopedModels(current, settings.getGlobalSettings().enabledModels ?? []);
  if (updated !== current) writeFileSync(instructionsPath, updated);
}
