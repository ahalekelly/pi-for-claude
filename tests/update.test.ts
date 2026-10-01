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

// A Node script that logs its name and arguments and answers `view` with UPDATE_VIEW, runnable as a POSIX executable or with node.
function logger(path: string, name: string): void {
  writeFileSync(path, `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.UPDATE_LOG, "${name}|" + process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "view") process.stdout.write(process.env.UPDATE_VIEW);
`);
  chmodSync(path, 0o755);
}

// Runs update against a checkout one commit behind upstream, with Pi's latest release published `ageMinutes` ago.
function runUpdate(ageMinutes: number): { log: string[]; home: string; upstream: string } {
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
  writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-ai": "^1.0.0", "@earendil-works/pi-coding-agent": "^1.0.0", yaml: "^2.0.0" } }));

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
  process.env.UPDATE_VIEW = JSON.stringify({ "dist-tags.latest": "1.1.0", time: { "1.1.0": new Date(Date.now() - ageMinutes * 60 * 1000).toISOString() } });
  try {
    update(home);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.UPDATE_LOG;
    delete process.env.UPDATE_VIEW;
  }
  return { log: readFileSync(log, "utf8").trim().split("\n"), home, upstream };
}

const views = [
  "npm|view @earendil-works/pi-ai dist-tags.latest time --json",
  "npm|view @earendil-works/pi-coding-agent dist-tags.latest time --json",
];

test("update pulls the checkout, moves Pi to its latest hour-old release, and refreshes extensions", () => {
  const { log, home, upstream } = runUpdate(61);
  assert.equal(git(home, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
  assert.deepEqual(log, [
    ...views,
    "npm|install --min-release-age=0 @earendil-works/pi-ai@1.1.0 @earendil-works/pi-coding-agent@1.1.0",
    "pi|update --extensions",
  ]);
});

test("update keeps the installed Pi while its latest release is under an hour old", () => {
  assert.deepEqual(runUpdate(5).log, [...views, "pi|update --extensions"]);
});

test("update refuses to run outside a git checkout", () => {
  assert.throws(() => update(withStrings(mkdtempSync(join(tmpdir(), "pi-for-claude-update-")))), /must run from its git checkout/);
});
