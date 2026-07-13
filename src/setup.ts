import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { agentPaths } from "./agent-paths.ts";
import { renderString } from "./core.ts";

type JsonObject = Record<string, unknown>;

function msg(home: string, name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

function object(value: unknown, context: string, home: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(msg(home, "setup-invalid-setting", { context }));
  return value as JsonObject;
}

function strings(value: unknown, context: string, home: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(msg(home, "setup-invalid-setting", { context }));
  return value as string[];
}

function ensureObject(parent: JsonObject, key: string, context: string, home: string): JsonObject {
  if (parent[key] === undefined) parent[key] = {};
  return object(parent[key], context, home);
}

function ensureStrings(parent: JsonObject, key: string, context: string, home: string): string[] {
  if (parent[key] === undefined) parent[key] = [];
  return strings(parent[key], context, home);
}

function appendMissing(path: string, lines: string[]): boolean {
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const existing = new Set(source.split(/\r?\n/));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) return false;
  mkdirSync(dirname(path), { recursive: true });
  const separator = source && !source.endsWith("\n") && !source.endsWith("\r") ? eol : "";
  writeFileSync(path, `${source}${separator}${missing.join(eol)}${eol}`);
  return true;
}

function gitIgnorePath(homeDir: string, stringsHome: string): string {
  const result = spawnSync("git", ["config", "--global", "core.excludesfile"], { encoding: "utf8" });
  if (result.error) throw new Error(msg(stringsHome, "could-not-run-git", { error: result.error.message }));
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || msg(stringsHome, "git-command-failed", { args: "config --global core.excludesfile" }));
  }
  const configured = result.status === 0 ? result.stdout.trim() : "";
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return join(homeDir, configured.slice(2));
  if (configured) return configured;
  const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, ".config");
  return join(configHome, "git", "ignore");
}

export function setup(home: string): void {
  const homeDir = homedir();
  const paths = agentPaths();
  const settingsPath = join(homeDir, ".claude", "settings.json");
  let settings: JsonObject = {};
  if (existsSync(settingsPath)) {
    try {
      settings = object(JSON.parse(readFileSync(settingsPath, "utf8")), "settings.json", home);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(msg(home, "setup-settings-unparseable", { path: settingsPath, error: error.message }));
      throw error;
    }
  }

  const sandbox = ensureObject(settings, "sandbox", "sandbox", home);
  const filesystem = ensureObject(sandbox, "filesystem", "sandbox.filesystem", home);
  const permissions = ensureObject(settings, "permissions", "permissions", home);
  const allowWrite = ensureStrings(filesystem, "allowWrite", "sandbox.filesystem.allowWrite", home);
  const allowRead = ensureStrings(filesystem, "allowRead", "sandbox.filesystem.allowRead", home);
  const deny = ensureStrings(permissions, "deny", "permissions.deny", home);
  const wanted = [
    [allowWrite, paths.realAuth],
    [allowWrite, paths.lock],
    [allowRead, paths.realAuth],
    ...[paths.auth, paths.realAuth].map((path) => [deny, `Read(${path})`] as [string[], string]),
  ] as Array<[string[], string]>;
  let settingsChanged = !existsSync(settingsPath);
  for (const [entries, entry] of wanted) {
    if (entries.includes(entry)) continue;
    entries.push(entry);
    settingsChanged = true;
  }
  if (settingsChanged) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  process.stdout.write(`${msg(home, settingsChanged ? "setup-settings-fixed" : "setup-settings-configured", { path: settingsPath })}\n`);

  const claudePath = join(homeDir, ".claude", "CLAUDE.md");
  const claudeSource = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
  const existingInclude = claudeSource.split(/\r?\n/).find((line) => line.includes("pi-for-claude-instructions.md"));
  if (existingInclude) {
    process.stdout.write(`${msg(home, "setup-claude-configured", { line: existingInclude })}\n`);
  } else {
    const include = `@${join(home, "prompts", "pi-for-claude-instructions.md")}`;
    appendMissing(claudePath, [include]);
    process.stdout.write(`${msg(home, "setup-claude-fixed", { path: claudePath })}\n`);
  }

  const ignorePath = gitIgnorePath(homeDir, home);
  const ignoreChanged = appendMissing(ignorePath, [".agents/sessions/", ".agents/plans/", ".agents/worktrees/"]);
  process.stdout.write(`${msg(home, ignoreChanged ? "setup-ignore-fixed" : "setup-ignore-configured", { path: ignorePath })}\n`);

  const loggedIn = existsSync(paths.auth) && statSync(paths.auth).size > 0;
  process.stdout.write(`${msg(home, loggedIn ? "setup-auth-configured" : "setup-auth-missing", { path: paths.auth })}\n`);
}
