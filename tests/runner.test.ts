import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mainCheckout, sessionIdFromPlan } from "../src/runner.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("mainCheckout resolves the shared checkout from a linked worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-run-git-"));
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.email", "pi-run@example.test");
  git(root, "config", "user.name", "pi-run test");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  const linked = join(root, "linked");
  git(root, "worktree", "add", "-b", "topic", linked);

  assert.equal(mainCheckout(linked), realpathSync(root));
});

test("sessionIdFromPlan accepts portable plan names and rejects unsafe ones", () => {
  assert.equal(sessionIdFromPlan("plans/fix-auth.md"), "fix-auth");
  assert.throws(() => sessionIdFromPlan("plans/Bad Plan.md"), /portable session id/);
});

test("run creates an isolated worktree and sends the composed prompt over RPC", () => {
  const root = mkdtempSync("/tmp/pi-run-e2e-");
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.email", "pi-run@example.test");
  git(root, "config", "user.name", "pi-run test");
  writeFileSync(join(root, ".gitignore"), ".agents/\n");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "initial");
  writeFileSync(join(root, "fix-auth.md"), "Fix the auth flow.\n");

  const fakePi = join(root, "fake-pi.mjs");
  const captured = join(root, "captured.txt");
  const piRunHome = join(root, "pi-run-home");
  mkdirSync(join(piRunHome, "prompts"), { recursive: true });
  writeFileSync(join(piRunHome, "models.json"), '{"default":"openai-codex/gpt-test"}\n');
  writeFileSync(
    join(piRunHome, "prompts", "run.md"),
    `---
description: Implement a plan
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: Ask when blocked
---
Do not run git commit or git push.
$plan
`,
  );
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const valueAfter = flag => process.argv[process.argv.indexOf(flag) + 1];
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline === -1) return;
  const command = JSON.parse(input.slice(0, newline));
  if (command.type !== "prompt") process.exit(2);
  writeFileSync(process.env.CAPTURED, command.message);
  const id = valueAfter("--session-id");
  const sessionDir = valueAfter("--session-dir");
  const message = {role:"assistant", content:[{type:"text", text:"Implemented auth."}]};
  writeFileSync(join(sessionDir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({type:"session", id}) + "\\n" + JSON.stringify({type:"message", message}) + "\\n");
  console.log(JSON.stringify({type:"response", id:command.id, command:"prompt", success:true}));
  console.log(JSON.stringify({type:"message_end", message}));
  console.log(JSON.stringify({type:"agent_settled"}));
});
`,
  );
  chmodSync(fakePi, 0o755);

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "run", root, "fix-auth.md"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_BIN: fakePi,
      PI_RUN_HOME: piRunHome,
      CAPTURED: captured,
    },
  });

  const worktree = join(realpathSync(root), ".agents/scratchpad/worktrees/fix-auth");
  assert.match(output, /Implemented auth\./);
  assert.equal(git(worktree, "branch", "--show-current"), "pi/fix-auth");
  assert.match(readFileSync(captured, "utf8"), /Fix the auth flow\./);
  assert.match(readFileSync(captured, "utf8"), /Do not run git commit or git push/);

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  assert.equal(execFileSync(process.execPath, [cli, "result", root, "fix-auth"], { encoding: "utf8" }), "Implemented auth.\n");
  writeFileSync(join(worktree, "auth.txt"), "fixed\n");
  writeFileSync(join(worktree, "README.md"), "session change\n");
  git(worktree, "add", "auth.txt");
  git(worktree, "add", "README.md");
  git(worktree, "commit", "-m", "Fix auth");
  writeFileSync(join(root, "README.md"), "main change\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "Move main");

  const conflicted = spawnSync(process.execPath, [cli, "merge", root, "fix-auth"], { encoding: "utf8" });
  assert.equal(conflicted.status, 1);
  assert.match(conflicted.stderr, /Rebase stopped with conflicts in:\nREADME.md/);
  writeFileSync(join(worktree, "README.md"), "resolved\n");
  git(worktree, "add", "README.md");
  git(worktree, "-c", "core.editor=true", "rebase", "--continue");

  assert.match(execFileSync(process.execPath, [cli, "merge", root, "fix-auth"], { encoding: "utf8" }), /Re-run verification/);
  assert.match(execFileSync(process.execPath, [cli, "merge", root, "fix-auth"], { encoding: "utf8" }), /Merged 'fix-auth'/);
  assert.equal(readFileSync(join(root, "auth.txt"), "utf8"), "fixed\n");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "resolved\n");
  assert.equal(existsSync(worktree), false);
  assert.equal(execFileSync(process.execPath, [cli, "result", root, "fix-auth"], { encoding: "utf8" }), "Implemented auth.\n");
});
