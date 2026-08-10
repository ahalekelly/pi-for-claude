import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  const piBin = join(home, "node_modules", ".bin");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(project);
  mkdirSync(bin);
  mkdirSync(piBin, { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));

  const log = join(root, "commands.log");
  executable(join(bin, "npm"), 'printf "npm|%s|%s\\n" "$PWD" "$*" >> "$UPDATE_LOG"');
  executable(join(piBin, "pi"), 'printf "pi|%s|%s\\n" "$PWD" "$*" >> "$UPDATE_LOG"');

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  process.env.UPDATE_LOG = log;
  try {
    update(home, project);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.UPDATE_LOG;
  }

  const [npm, pi] = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|"));
  assert.equal(npm?.[0], "npm");
  assert.equal(realpathSync(npm?.[1] ?? ""), realpathSync(home));
  assert.equal(
    npm?.[2],
    "install @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest @earendil-works/pi-tui@latest agent-browser@latest pi-agent-browser-native@latest pi-web-access@latest",
  );
  assert.equal(pi?.[0], "pi");
  assert.equal(realpathSync(pi?.[1] ?? ""), realpathSync(project));
  assert.equal(pi?.[2], "update --extensions");
});
