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

// A project is either the root of the working tree you launch from — a
// linked worktree keeps its own .agents/ (sessions, plans, pi worktrees), so
// delegation from inside a worktree stays inside it, never resolving up to a
// shared checkout — or a standalone directory with no git checkout of its
// own, either because no repository contains it, or because the enclosing
// repository ignores it and so can never treat it as part of the checkout.
export type ResolvedProject = { kind: "checkout"; main: string } | { kind: "standalone"; dir: string };

export function resolveProject(projectDir: string): ResolvedProject {
  const project = resolve(projectDir);
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(msg("could-not-run-git", { error: result.error.message }));
  if (result.status !== 0) {
    if (result.stderr.includes("not a git repository")) return { kind: "standalone", dir: project };
    if (result.stderr.includes("must be run in a work tree")) throw new Error(msg("bare-repository-unsupported"));
    throw new Error(result.stderr.trim() || msg("git-command-failed", { args: "rev-parse --path-format=absolute --show-toplevel" }));
  }
  const toplevel = result.stdout.trim();
  // git rev-parse walks up from any subdirectory, so without this check a
  // launch from a directory that merely sits inside some checkout (e.g. a
  // scratch dir under a git-tracked home) silently adopts that repository as
  // the project.
  const realProject = realpathSync(project);
  if (realProject !== toplevel) {
    // An ignored directory can never become part of the enclosing repository,
    // so it is a standalone non-git project rather than a rejected subdirectory.
    const ignored = spawnSync("git", ["-C", realProject, "check-ignore", "-q", "--", realProject], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (ignored.error) throw new Error(msg("could-not-run-git", { error: ignored.error.message }));
    if (ignored.status === 0) return { kind: "standalone", dir: project };
    if (ignored.status !== 1) throw new Error(ignored.stderr.trim() || msg("git-command-failed", { args: "check-ignore -q" }));
    throw new Error(msg("project-not-checkout-root", { project, root: toplevel }));
  }
  return { kind: "checkout", main: toplevel };
}

export function sessionIdFromPlan(planPath: string): string {
  const name = basename(planPath, extname(planPath));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(msg("plan-name-not-portable", { name }));
  }
  return name;
}
