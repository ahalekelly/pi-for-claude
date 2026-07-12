import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";

export type FilesystemPolicy = {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
};

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
  return denied ? `Read denied: '${path}' is under restricted path '${denied}'` : "";
}

export function writeBlocked(path: string, policy: FilesystemPolicy, cwd: string, readOnly: boolean): string {
  if (readOnly) return `Write denied: '${path}' because this command is read-only`;
  const target = absolute(path, cwd);
  if (target.split(sep).includes(".git")) return `Write denied: '${path}' targets restricted .git metadata`;
  const denied = policy.denyWrite.find((pattern) => matchesName(target, pattern));
  if (denied) return `Write denied: '${path}' matches restricted pattern '${denied}'`;
  const allowed = policy.allowWrite.some((entry) => under(target, absolute(entry, cwd)));
  return allowed ? "" : `Write denied: '${path}' is outside allowed paths`;
}
