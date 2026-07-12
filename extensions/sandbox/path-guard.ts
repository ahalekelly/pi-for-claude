import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { renderString } from "../../src/core.ts";

export type FilesystemPolicy = {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  gitWrite: string[];
};

const stringsPath = join(import.meta.dirname, "../..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string>): string {
  return renderString(stringsPath, name, injections);
}

function absolute(path: string, cwd: string): string {
  const resolved = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(resolved);
    if (parent === resolved) throw error;
    return resolve(absolute(parent, cwd), relative(parent, resolved));
  }
}

function under(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function matchesName(path: string, pattern: string): boolean {
  const name = basename(path);
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

export function readBlocked(path: string, policy: FilesystemPolicy, cwd: string): string {
  const target = absolute(path, cwd);
  const denied = policy.denyRead.find((entry) => under(target, absolute(entry, cwd)));
  return denied ? msg("read-denied", { path, entry: denied }) : "";
}

export function writeBlocked(path: string, policy: FilesystemPolicy, cwd: string, readOnly: boolean): string {
  if (readOnly) return msg("write-denied-read-only", { path });
  const target = absolute(path, cwd);
  const denied = policy.denyWrite.find((pattern) => matchesName(target, pattern));
  if (denied) return msg("write-denied-pattern", { path, pattern: denied });
  const gitAllowed = policy.gitWrite.some((entry) => under(target, absolute(entry, cwd)));
  if (target.split(sep).includes(".git") && !gitAllowed) return msg("write-denied-git-metadata", { path });
  const allowed = gitAllowed || policy.allowWrite.some((entry) => under(target, absolute(entry, cwd)));
  return allowed ? "" : msg("write-denied-outside-allowed", { path });
}
