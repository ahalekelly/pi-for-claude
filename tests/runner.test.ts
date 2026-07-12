import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function scratchRepo(prefix: string): string {
  const root = mkdtempSync(`/tmp/${prefix}`);
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.email", "pi-run@example.test");
  git(root, "config", "user.name", "pi-run test");
  writeFileSync(join(root, ".gitignore"), ".agents/\n");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "initial");
  return root;
}

function makePiRunHome(root: string): string {
  const piRunHome = join(root, "pi-run-home");
  mkdirSync(join(piRunHome, "prompts"), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(piRunHome, "prompts/strings.json"));
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
  return piRunHome;
}

test("run creates an isolated worktree and sends the composed prompt over RPC", () => {
  const root = scratchRepo("pi-run-e2e-");
  writeFileSync(join(root, "fix-auth.md"), "Fix the auth flow.\n");

  const fakePi = join(root, "fake-pi.mjs");
  const captured = join(root, "captured.txt");
  const piRunHome = makePiRunHome(root);
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

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "run", "fix-auth.md"], {
    encoding: "utf8",
    cwd: root,
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
  assert.equal(execFileSync(process.execPath, [cli, "result", "fix-auth"], { encoding: "utf8", cwd: root }), "Implemented auth.\n");
  writeFileSync(join(worktree, "auth.txt"), "fixed\n");
  writeFileSync(join(worktree, "README.md"), "session change\n");
  writeFileSync(join(root, "README.md"), "main change\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "Move main");

  const dirty = spawnSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: root });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted changes/);

  git(worktree, "add", "auth.txt");
  git(worktree, "commit", "-m", "Fix auth flow");
  git(worktree, "add", "README.md");
  git(worktree, "commit", "-m", "Handle session change");

  const conflicted = spawnSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: root });
  assert.equal(conflicted.status, 1);
  assert.match(conflicted.stderr, /Rebase stopped with conflicts in:\nREADME.md/);

  const midRebase = spawnSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: root });
  assert.equal(midRebase.status, 1);
  assert.match(midRebase.stderr, /rebase in progress/);

  writeFileSync(join(worktree, "README.md"), "resolved\n");
  git(worktree, "add", "README.md");
  git(worktree, "-c", "core.editor=true", "rebase", "--continue");

  assert.match(execFileSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: root }), /Re-run verification/);
  assert.match(execFileSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: root }), /Merged 'fix-auth'/);
  assert.equal(readFileSync(join(root, "auth.txt"), "utf8"), "fixed\n");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "resolved\n");
  assert.equal(git(root, "log", "-1", "--format=%s"), "Handle session change");
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "4", "the session's commits fast-forward onto main verbatim");
  assert.equal(existsSync(worktree), false);
  assert.equal(execFileSync(process.execPath, [cli, "result", "fix-auth"], { encoding: "utf8", cwd: root }), "Implemented auth.\n");
});

test("failures before and during a run fail fast without burning the session id", () => {
  const root = scratchRepo("pi-run-fail-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const worktree = join(root, ".agents/scratchpad/worktrees/plan");
  const sessionFile = join(root, ".agents/scratchpad/pi/sessions/plan.pi-run.json");
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "run", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, PI_RUN_HOME: piRunHome, ...env }, timeout: 15000 });

  const badModel = run({}, "plan.md", "--model", "nope");
  assert.equal(badModel.status, 1);
  assert.match(badModel.stderr, /Unknown model label 'nope'/);
  const missingPlan = run({}, "absent.md");
  assert.equal(missingPlan.status, 1);
  assert.match(missingPlan.stderr, /Plan file does not exist/);
  const missingAttachment = run({}, "plan.md", "--pre", "absent.txt");
  assert.equal(missingAttachment.status, 1);
  assert.match(missingAttachment.stderr, /Attachment file does not exist/);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(sessionFile), false);

  const crashPi = join(root, "crash-pi.mjs");
  writeFileSync(crashPi, `#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(2);\n`);
  chmodSync(crashPi, 0o755);
  const crashed = run({ PI_BIN: crashPi }, "plan.md");
  assert.equal(crashed.signal, null, "pi-run must exit on its own instead of hanging");
  assert.equal(crashed.status, 1);
  assert.match(crashed.stderr, /pi exited before agent_settled \(2\)/);

  const errorPi = join(root, "error-pi.mjs");
  writeFileSync(
    errorPi,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const command = JSON.parse(input.split("\\n")[0]);
  console.log(JSON.stringify({type:"response", id:command.id, command:"prompt", success:true}));
  console.log(JSON.stringify({type:"message_end", message:{role:"assistant", content:[], stopReason:"error", errorMessage:"Codex error: The usage limit has been reached"}}));
  console.log(JSON.stringify({type:"agent_settled"}));
});
`,
  );
  chmodSync(errorPi, 0o755);
  writeFileSync(join(root, "plan2.md"), "Do the thing.\n");
  const provider = run({ PI_BIN: errorPi }, "plan2.md");
  assert.equal(provider.signal, null, "pi-run must exit on its own instead of hanging");
  assert.equal(provider.status, 1);
  assert.match(provider.stderr, /The usage limit has been reached/);
});

test("a live control socket blocks a new run; a stale one is cleaned up", async () => {
  const root = scratchRepo("pi-run-guard-");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const sessions = join(root, ".agents/scratchpad/pi/sessions");
  mkdirSync(sessions, { recursive: true });
  const crashPi = join(root, "crash-pi.mjs");
  writeFileSync(crashPi, `#!/usr/bin/env node\nprocess.exit(2);\n`);
  chmodSync(crashPi, 0o755);
  const run = (plan: string) =>
    spawnSync(process.execPath, [cli, "run", plan], { encoding: "utf8", cwd: root, env: { ...process.env, PI_RUN_HOME: piRunHome, PI_BIN: crashPi }, timeout: 15000 });

  writeFileSync(join(root, "live.md"), "Do the thing.\n");
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(join(sessions, "live.ctl"), resolveListen));
  try {
    const blocked = run("live.md");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Session 'live' is currently running/);
  } finally {
    server.close();
  }

  writeFileSync(join(root, "stale.md"), "Do the thing.\n");
  writeFileSync(join(sessions, "stale.ctl"), "");
  const proceeded = run("stale.md");
  assert.equal(proceeded.status, 1);
  assert.match(proceeded.stderr, /pi exited before agent_settled \(2\)/, "the stale socket must be removed so the run reaches pi");
});

function writeBouncePi(root: string): string {
  const fakePi = join(root, "bounce-pi.mjs");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const valueAfter = flag => process.argv[process.argv.indexOf(flag) + 1];
const reply = (id, text) => {
  const message = {role:"assistant", content:[{type:"text", text}]};
  writeFileSync(join(valueAfter("--session-dir"), "2026-01-01T00-00-00-000Z_" + valueAfter("--session-id") + ".jsonl"), JSON.stringify({type:"message", message}) + "\\n");
  console.log(JSON.stringify({type:"response", id:id, command:"prompt", success:true}));
  console.log(JSON.stringify({type:"message_end", message}));
  console.log(JSON.stringify({type:"agent_settled"}));
};
let round = 0;
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) !== -1) {
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (command.type !== "prompt") continue;
    round += 1;
    if (round === 1) {
      writeFileSync("dirt.txt", "dirt\\n");
      reply(command.id, "Left dirt.");
    } else if (process.env.FIX === "1") {
      writeFileSync(process.env.CAPTURED, command.message);
      execSync("git add -A && git commit -m 'Fix dirt'");
      reply(command.id, "Committed.");
    } else {
      reply(command.id, "Still dirty.");
    }
  }
});
`,
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
}

test("an unclean handback bounces back to pi until it merges cleanly", () => {
  const root = scratchRepo("pi-run-bounce-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const captured = join(root, "captured.txt");
  const output = execFileSync(process.execPath, [cli, "run", "plan.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_BIN: writeBouncePi(root), PI_RUN_HOME: piRunHome, CAPTURED: captured, FIX: "1" },
  });
  assert.match(output, /Committed\./);
  assert.match(readFileSync(captured, "utf8"), /uncommitted changes/);
  const worktree = join(realpathSync(root), ".agents/scratchpad/worktrees/plan");
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Fix dirt");
});

test("a second unclean handback settles and reports the problem to the orchestrator", () => {
  const root = scratchRepo("pi-run-stubborn-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const run = spawnSync(process.execPath, [cli, "run", "plan.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_BIN: writeBouncePi(root), PI_RUN_HOME: piRunHome },
    timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Still dirty\./);
  assert.match(run.stdout, /WARNING: the session did not hand back cleanly/);
  assert.match(run.stdout, /dirt\.txt/);
});

test("discard removes a direct session's record without touching git", () => {
  const root = scratchRepo("pi-run-direct-");
  const sessions = join(root, ".agents/scratchpad/pi/sessions");
  mkdirSync(sessions, { recursive: true });
  const record = {
    kind: "direct",
    id: "review-1",
    command: "review",
    mainCheckout: root,
    worktree: root,
    baseCommit: git(root, "rev-parse", "HEAD"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(sessions, "review-1.pi-run.json"), JSON.stringify(record));

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const output = execFileSync(process.execPath, [cli, "discard", "review-1"], { encoding: "utf8", cwd: root });
  assert.match(output, /Discarded 'review-1'/);
  assert.equal(existsSync(join(sessions, "review-1.pi-run.json")), false);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("watch prints each question once and exits when the session ends", async () => {
  const root = scratchRepo("pi-run-watch-");
  const sessions = join(root, ".agents/scratchpad/pi/sessions");
  mkdirSync(sessions, { recursive: true });
  const record = {
    kind: "direct",
    id: "w1",
    command: "review",
    mainCheckout: root,
    worktree: root,
    baseCommit: git(root, "rev-parse", "HEAD"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const recordPath = join(sessions, "w1.pi-run.json");
  writeFileSync(recordPath, JSON.stringify(record));
  const question = join(sessions, "w1.question.md");
  const answer = join(realpathSync(root), ".agents/scratchpad/pi/sessions", "w1.answer.md");
  writeFileSync(question, "Which auth flow?");

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const child = spawn(process.execPath, [cli, "watch", "w1"], { cwd: root });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const deadline = Date.now() + 15000;
  const waitUntil = async (predicate: () => boolean) => {
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail("timed out waiting for watch output");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  };

  try {
    await waitUntil(() => stdout.includes("Which auth flow?"));
    assert.match(stdout, new RegExp(`Answer by writing ${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    rmSync(question);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    assert.equal(stdout.match(/Which auth flow\?/g)?.length, 1);

    rmSync(recordPath);
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0);
    assert.match(stdout, /has ended/);
  } finally {
    if (existsSync(recordPath)) rmSync(recordPath);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
