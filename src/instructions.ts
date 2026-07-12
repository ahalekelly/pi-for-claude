import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

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

export function refreshInstructions(home: string, cwd: string): void {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const error = settings.drainErrors().find(({ scope }) => scope === "global");
  if (error) throw error.error;
  const instructionsPath = join(home, "prompts", "pi-for-claude-instructions.md");
  const current = readFileSync(instructionsPath, "utf8");
  const updated = renderScopedModels(current, settings.getGlobalSettings().enabledModels ?? []);
  if (updated !== current) writeFileSync(instructionsPath, updated);
}
