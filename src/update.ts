import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { renderString } from "./core.ts";

function msg(home: string, name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

// Windows Node refuses to spawn npm.cmd unless it goes through a shell (CVE-2024-27980). Only
// npm may take this path: a shell re-splits arguments, mangling paths that contain spaces.
const npmShell = process.platform === "win32";

function run(home: string, command: string, args: string[], cwd: string, shell = false): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell });
  if (result.error) throw new Error(msg(home, "could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) throw new Error(msg(home, "update-command-failed", { command, status: String(result.status) }));
}

function output(home: string, command: string, args: string[], cwd: string, shell = false): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell });
  if (result.error) throw new Error(msg(home, "could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) throw new Error(msg(home, "update-command-failed", { command, status: String(result.status) }));
  return result.stdout.trim();
}

export function packageVersion(home: string): string {
  const metadata = JSON.parse(readFileSync(join(home, "package.json"), "utf8")) as Record<string, unknown>;
  if (metadata.name !== "pi-for-claude" || typeof metadata.version !== "string") throw new Error(msg(home, "package-metadata-invalid"));
  return metadata.version;
}

export function showVersion(home: string, executable: string): void {
  const current = packageVersion(home);
  const revision = existsSync(join(home, ".git"))
    ? output(home, "git", ["-C", home, "rev-parse", "HEAD"], home)
    : `v${current}`;
  const latest = output(home, "npm", ["view", "pi-for-claude", "version"], home, npmShell);
  process.stdout.write(msg(home, "version-info", {
    version: current,
    revision,
    executable: realpathSync(executable),
    latest,
  }));
}

export function update(home: string, project: string): void {
  process.stdout.write(`${msg(home, "update-package")}\n`);
  run(home, "npm", ["install", "--global", "pi-for-claude@latest"], project, npmShell);

  process.stdout.write(`${msg(home, "update-extensions")}\n`);
  const globalRoot = output(home, "npm", ["root", "--global"], project, npmShell);
  const piCli = join(globalRoot, "pi-for-claude", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  run(home, process.execPath, [piCli, "update", "--extensions"], project);
}
