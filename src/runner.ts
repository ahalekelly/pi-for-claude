import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

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

// The working tree you launch from is the project: a linked worktree keeps
// its own .agents/ (sessions, plans, pi worktrees), so delegation from inside
// a worktree stays inside it — nothing resolves up to the shared checkout.
export function checkoutRoot(projectDir: string): string {
  const project = resolve(projectDir);
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(msg("could-not-run-git", { error: result.error.message }));
  if (result.status !== 0) {
    if (result.stderr.includes("not a git repository")) return project;
    if (result.stderr.includes("must be run in a work tree")) throw new Error(msg("bare-repository-unsupported"));
    throw new Error(result.stderr.trim() || msg("git-command-failed", { args: "rev-parse --path-format=absolute --show-toplevel" }));
  }
  const toplevel = result.stdout.trim();
  // git rev-parse walks up from any subdirectory, so without this check a
  // launch from a directory that merely sits inside some checkout (e.g. a
  // scratch dir under a git-tracked home) silently adopts that repository as
  // the project.
  if (realpathSync(project) !== toplevel) throw new Error(msg("project-not-checkout-root", { project, root: toplevel }));
  return toplevel;
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
