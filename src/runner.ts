import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";

import { renderString } from "./core.ts";

const stringsPath = join(import.meta.dirname, "..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(stringsPath, name, injections);
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(msg("could-not-run-git", { error: result.error.message }));
  if (result.status !== 0) throw new Error(result.stderr.trim() || msg("git-command-failed", { args: args.join(" ") }));
  return result.stdout.trim();
}

export function mainCheckout(projectDir: string): string {
  const project = resolve(projectDir);
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(msg("could-not-run-git", { error: result.error.message }));
  if (result.status !== 0) {
    if (result.stderr.includes("not a git repository")) return project;
    throw new Error(result.stderr.trim() || msg("git-command-failed", { args: "rev-parse --path-format=absolute --git-common-dir" }));
  }
  const commonDir = result.stdout.trim();
  if (git(project, ["rev-parse", "--is-bare-repository"]) === "true") throw new Error(msg("bare-repository-unsupported"));
  if (basename(commonDir) !== ".git") throw new Error(msg("unsupported-git-common-dir", { dir: commonDir }));
  return dirname(commonDir);
}

export function isGitRepository(project: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: project, encoding: "utf8" });
  if (result.error) throw new Error(msg("could-not-run-git", { error: result.error.message }));
  return result.status === 0 && result.stdout.trim() === "true";
}

export function sessionIdFromPlan(planPath: string): string {
  const name = basename(planPath, extname(planPath));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(msg("plan-name-not-portable", { name }));
  }
  return name;
}
