import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { update } from "../src/update.ts";

function checkout(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-for-claude-update-"));
  mkdirSync(join(home, "prompts"), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));
  return home;
}

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

test("update pulls the checkout, installs dependencies, and refreshes extensions", () => {
  const home = checkout();
  const bin = join(home, "bin");
  const piBin = join(home, "node_modules", ".bin");
  mkdirSync(join(home, ".git"));
  mkdirSync(bin);
  mkdirSync(piBin, { recursive: true });

  const log = join(home, "commands.log");
  executable(join(bin, "git"), 'printf "git|%s\\n" "$*" >> "$UPDATE_LOG"');
  executable(join(bin, "npm"), 'printf "npm|%s\\n" "$*" >> "$UPDATE_LOG"');
  executable(join(piBin, "pi"), 'printf "pi|%s\\n" "$*" >> "$UPDATE_LOG"');

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  process.env.UPDATE_LOG = log;
  try {
    update(home);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.UPDATE_LOG;
  }

  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    `git|-C ${home} pull --ff-only`,
    "npm|install",
    "pi|update --extensions",
  ]);
});

test("update refuses to run outside a git checkout", () => {
  assert.throws(() => update(checkout()), /must run from its git checkout/);
});
