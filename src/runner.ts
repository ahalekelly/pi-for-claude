import { spawnSync } from "node:child_process";
import { basename, dirname, extname, resolve } from "node:path";

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function mainCheckout(projectDir: string): string {
  const project = resolve(projectDir);
  const commonDir = git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (basename(commonDir) !== ".git") throw new Error(`Unsupported git common directory: ${commonDir}`);
  return dirname(commonDir);
}

export function sessionIdFromPlan(planPath: string): string {
  const name = basename(planPath, extname(planPath));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Plan name '${name}' must be a portable session id using lowercase letters, numbers, and hyphens`);
  }
  return name;
}
