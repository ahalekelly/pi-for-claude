import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { update } from "../src/update.ts";

function fakeHome(root: string): string {
  const home = join(root, "home");
  mkdirSync(join(home, "prompts"), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(home, "prompts", "strings.json"));
  return home;
}

test("update refreshes Pi, bundled extensions, and installed extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-update-"));
  const home = fakeHome(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const globalRoot = join(root, "global", "node_modules");
  const piPackage = join(globalRoot, "pi-for-claude", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(project);
  mkdirSync(join(piPackage, "dist"), { recursive: true });
  writeFileSync(join(piPackage, "package.json"), '{ "name": "@earendil-works/pi-coding-agent" }\n');
  writeFileSync(join(piPackage, "dist", "cli.js"), 'require("node:fs").appendFileSync(process.env.UPDATE_LOG, `pi|${process.cwd()}|${process.argv.slice(2).join(" ")}\\n`);\n');

  // POSIX runs npm from PATH; Windows runs the npm-cli.js that sits in node_modules beside it.
  const npm = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
require("node:fs").appendFileSync(process.env.UPDATE_LOG, \`npm|\${process.cwd()}|\${args}\\n\`);
if (args === "root --global") console.log(process.env.GLOBAL_ROOT);
`;
  mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(bin, "npm"), npm);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), npm);

  const log = join(root, "commands.log");
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

test("update refuses to replace a checkout with the published package", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-update-checkout-"));
  const home = fakeHome(root);
  mkdirSync(join(home, ".git"));
  assert.throws(() => update(home, root), /running from the checkout .* 'git pull'/);
});
