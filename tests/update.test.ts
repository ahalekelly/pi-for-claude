import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { packageVersion, showVersion, update } from "../src/update.ts";

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

test("version reports the local version when npm is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-version-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(bin);
  cpSync(join(import.meta.dirname, "../package.json"), join(home, "package.json"));
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));
  executable(join(bin, "npm"), 'printf "npm ERR! code E407\\n" >&2\nexit 1');

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  try {
    const output = showVersion(home, join(bin, "npm"));
    assert.match(output, new RegExp(`Version: ${packageVersion(home)}`));
    assert.match(output, /Latest: unknown — .*npm ERR! code E407/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("update refreshes Pi, bundled extensions, and installed extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-update-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const globalRoot = join(root, "global", "node_modules");
  const piBin = join(globalRoot, "pi-for-claude", "node_modules", ".bin");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(project);
  mkdirSync(bin);
  mkdirSync(piBin, { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));

  const log = join(root, "commands.log");
  executable(join(bin, "npm"), 'printf "npm|%s|%s\\n" "$PWD" "$*" >> "$UPDATE_LOG"\nif [ "$*" = "root --global" ]; then printf "%s\\n" "$GLOBAL_ROOT"; fi');
  executable(join(piBin, "pi"), 'printf "pi|%s|%s\\n" "$PWD" "$*" >> "$UPDATE_LOG"');

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  process.env.UPDATE_LOG = log;
  process.env.GLOBAL_ROOT = globalRoot;
  try {
    update(home, project);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.UPDATE_LOG;
    delete process.env.GLOBAL_ROOT;
  }

  const [install, rootCommand, pi] = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|"));
  assert.equal(install?.[0], "npm");
  assert.equal(realpathSync(install?.[1] ?? ""), realpathSync(project));
  assert.equal(install?.[2], "install --global pi-for-claude@latest");
  assert.equal(rootCommand?.[0], "npm");
  assert.equal(rootCommand?.[2], "root --global");
  assert.equal(pi?.[0], "pi");
  assert.equal(realpathSync(pi?.[1] ?? ""), realpathSync(project));
  assert.equal(pi?.[2], "update --extensions");
});
