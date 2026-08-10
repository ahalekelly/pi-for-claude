import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { renderString } from "./core.ts";

const PACKAGES = [
  "@earendil-works/pi-ai@latest",
  "@earendil-works/pi-coding-agent@latest",
  "@earendil-works/pi-tui@latest",
  "agent-browser@latest",
  "pi-agent-browser-native@latest",
  "pi-web-access@latest",
];

function msg(home: string, name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

function run(home: string, command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw new Error(msg(home, "could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) throw new Error(msg(home, "update-command-failed", { command, status: String(result.status) }));
}

export function update(home: string, project: string): void {
  process.stdout.write(`${msg(home, "update-pi")}\n`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(home, npm, ["install", ...PACKAGES], home);

  process.stdout.write(`${msg(home, "update-extensions")}\n`);
  const pi = join(home, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  run(home, pi, ["update", "--extensions"], project);
}
