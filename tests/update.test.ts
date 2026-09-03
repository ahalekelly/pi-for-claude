import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { update } from "../src/update.ts";

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

test("update refreshes Pi, bundled extensions, and installed extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-update-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const globalRoot = join(root, "global", "node_modules");
  const piCli = join(globalRoot, "pi-for-claude", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(project);
  mkdirSync(bin);
  mkdirSync(dirname(piCli), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));

  const log = join(root, "commands.log");
  executable(join(bin, "npm"), 'printf "npm|%s|%s\\n" "$PWD" "$*" >> "$UPDATE_LOG"\nif [ "$*" = "root --global" ]; then printf "%s\\n" "$GLOBAL_ROOT"; fi');
  writeFileSync(piCli, 'require("node:fs").appendFileSync(process.env.UPDATE_LOG, `pi|${process.cwd()}|${process.argv.slice(2).join(" ")}\\n`);\n');

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
