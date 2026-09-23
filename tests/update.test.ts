import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { update } from "../src/update.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function withStrings(home: string): string {
  mkdirSync(join(home, "prompts"), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));
  return home;
}

// A Node script that logs its name and arguments, runnable as a POSIX executable or with node.
function logger(path: string, name: string): void {
  writeFileSync(path, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.UPDATE_LOG, "${name}|" + process.argv.slice(2).join(" ") + "\\n");\n`);
  chmodSync(path, 0o755);
}

test("update pulls the checkout, installs dependencies, and refreshes extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-update-"));
  const upstream = join(root, "upstream");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(upstream);
  git(upstream, "init", "-b", "main");
  git(upstream, "commit", "--allow-empty", "-m", "initial");
  git(root, "clone", "-q", upstream, home);
  git(upstream, "commit", "--allow-empty", "-m", "newer");
  withStrings(home);

  const piPackage = join(home, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(piPackage, "dist"), { recursive: true });
  writeFileSync(join(piPackage, "package.json"), '{ "name": "@earendil-works/pi-coding-agent" }\n');
  logger(join(piPackage, "dist", "cli.js"), "pi");
  // POSIX runs npm from PATH; Windows runs the npm-cli.js that sits in node_modules beside it.
  mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  logger(join(bin, "npm"), "npm");
  logger(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "npm");

  const log = join(root, "commands.log");
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  process.env.UPDATE_LOG = log;
  try {
    update(home);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.UPDATE_LOG;
  }

  assert.equal(git(home, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["npm|install", "pi|update --extensions"]);
});

test("update refuses to run outside a git checkout", () => {
  assert.throws(() => update(withStrings(mkdtempSync(join(tmpdir(), "pi-for-claude-update-")))), /must run from its git checkout/);
});
