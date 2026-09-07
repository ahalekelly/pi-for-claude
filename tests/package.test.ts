import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("the installed package runs compiled JavaScript from node_modules", () => {
  const root = join(import.meta.dirname, "..");
  const pkg = join(mkdtempSync(join(tmpdir(), "pi-for-claude-package-")), "node_modules", "pi-for-claude");
  mkdirSync(pkg, { recursive: true });

  execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(root, "tsconfig.build.json"),
    "--outDir",
    join(pkg, "dist"),
  ]);
  cpSync(join(root, "package.json"), join(pkg, "package.json"));
  cpSync(join(root, "models.json"), join(pkg, "models.json"));
  cpSync(join(root, "prompts"), join(pkg, "prompts"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir");

  const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    bin: { "pi-for-claude": string };
  };
  const entry = join(pkg, metadata.bin["pi-for-claude"]);
  const output = execFileSync(process.execPath, [entry, "help"], {
    cwd: dirname(pkg),
    encoding: "utf8",
  });

  assert.match(output, /^Usage: pi-for-claude/);
  assert.match(readFileSync(entry, "utf8"), /^#!\/usr\/bin\/env node/);
});
