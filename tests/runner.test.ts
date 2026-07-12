import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { mainCheckout, sessionIdFromPlan } from "../src/runner.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const createdAt = "2026-01-01T00:00:00.000Z";
const createdAtPrefix = "2026-01-01T00-00-00-000Z";

function fixedSessionPath(sessions: string, id: string): string {
  return join(sessions, `${createdAtPrefix}-${id}.pi-run.json`);
}

function sessionArtifact(sessions: string, id: string, extension: "pi-run.json" | "log"): string {
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-(.+)\\.${extension.replace(".", "\\.")}$`);
  const files = readdirSync(sessions).filter((file) => pattern.exec(file)?.[1] === id);
  assert.equal(files.length, 1);
  return join(sessions, files[0]!);
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

test("mainCheckout rejects a bare repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-run-bare-"));
  git(root, "init", "--bare");
  assert.throws(() => mainCheckout(root), /Bare git repositories are not supported/);
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
    join(piRunHome, "prompts", "implement-in-worktree.md"),
    `---
description: Implement a plan
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: Ask when blocked
output-append: |
  echo appended
---
Do not run git commit or git push.
$plan
`,
  );
  writeFileSync(
    join(piRunHome, "prompts", "run.md"),
    `---
description: Implement a plan in place
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: project-write
worktree: none
session: new
consult: Ask when blocked
---
Make the requested changes.
$plan
`,
  );
  writeFileSync(
    join(piRunHome, "prompts", "review.md"),
    `---
description: Review a project
argument-hint: "[focus]"
model: default
thinking: high
sandbox: read-only
worktree: none
session: new
consult: Ask when blocked
---
Review the project.
`,
  );
  writeFileSync(
    join(piRunHome, "prompts", "resume.md"),
    `---
description: Continue a session
argument-hint: "<session> <follow-up>"
model: default
thinking: high
sandbox: worktree-write
worktree: reuse
session: continue
consult: Ask when blocked
---
$@
`,
  );
  return piRunHome;
}

function writeInPlacePi(root: string): string {
  const fakePi = join(root, "in-place-pi.mjs");
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
  writeFileSync(${JSON.stringify(join(root, "pi-args.json"))}, JSON.stringify(process.argv));
  writeFileSync(process.env.WRITTEN_FILE, "implemented\\n");
  const id = valueAfter("--session-id");
  const sessionDir = valueAfter("--session-dir");
  const message = {role:"assistant", content:[{type:"text", text:"Implemented in place."}]};
  writeFileSync(join(sessionDir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({type:"session", id}) + "\\n" + JSON.stringify({type:"message", message}) + "\\n");
  console.log(JSON.stringify({type:"response", id:command.id, command:"prompt", success:true}));
  console.log(JSON.stringify({type:"message_end", message}));
  console.log(JSON.stringify({type:"agent_settled"}));
});
`,
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
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

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "implement-in-worktree", "fix-auth.md"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      PI_BIN: fakePi,
      PI_RUN_HOME: piRunHome,
      CAPTURED: captured,
    },
  });

  const worktree = join(realpathSync(root), ".agents/worktrees/fix-auth");
  assert.match(output, /Implemented auth\./);
  assert.match(output, /\+ echo appended\nappended/, "output-append shows each command with its output");
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

test("rpcRun passes the sandboxed bash allowlist in every mode", () => {
  const root = scratchRepo("pi-run-tools-");
  const piRunHome = makePiRunHome(root);
  const fakePi = writeInPlacePi(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  writeFileSync(join(root, "worktree.md"), "Do the thing.\n");
  writeFileSync(join(root, "in-place.md"), "Do the thing.\n");

  const piArgsFor = (command: string, ...args: string[]) => {
    execFileSync(process.execPath, [cli, command, ...args], {
      cwd: root,
      env: { ...process.env, PI_BIN: fakePi, PI_RUN_HOME: piRunHome, WRITTEN_FILE: join(root, "implemented.txt") },
    });
    const piArgs: unknown = JSON.parse(readFileSync(join(root, "pi-args.json"), "utf8"));
    assert.ok(Array.isArray(piArgs) && piArgs.every((value) => typeof value === "string"));
    return piArgs;
  };

  const worktree = piArgsFor("implement-in-worktree", "worktree.md");
  const inPlace = piArgsFor("run", "in-place.md");
  const review = piArgsFor("review");
  const tools = (args: string[]) => args[args.indexOf("--tools") + 1];

  assert.equal(tools(worktree), "read,bash,write,edit,grep,find,ls");
  assert.equal(tools(inPlace), "read,bash,write,edit,grep,find,ls");
  assert.equal(tools(review), "read,bash,grep,find,ls");
  assert.ok([worktree, inPlace, review].every((args) => args.includes("--no-extensions")));
});

test("run edits a non-git project in place and discard preserves its files", () => {
  const root = mkdtempSync("/tmp/pi-run-in-place-non-git-");
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const output = execFileSync(process.execPath, [cli, "run", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      PI_BIN: writeInPlacePi(root),
      PI_RUN_HOME: makePiRunHome(root),
      WRITTEN_FILE: join(root, "implemented.txt"),
    },
  });

  const sessions = join(root, ".agents/sessions");
  const recordPath = sessionArtifact(sessions, "change", "pi-run.json");
  const logPath = sessionArtifact(sessions, "change", "log");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const prefix = record.createdAt.replaceAll(":", "-").replaceAll(".", "-");
  assert.equal(basename(recordPath), `${prefix}-change.pi-run.json`);
  assert.equal(basename(logPath), `${prefix}-change.log`);
  assert.match(output, /Implemented in place\./);
  assert.equal(record.kind, "in-place");
  assert.equal(record.worktree, realpathSync(root));
  assert.equal(readFileSync(join(root, "implemented.txt"), "utf8"), "implemented\n");
  assert.equal(existsSync(join(root, ".git")), false);
  assert.equal(existsSync(join(root, ".agents/worktrees/change")), false);
  assert.equal(execFileSync(process.execPath, [cli, "result", "change"], { encoding: "utf8", cwd: root }), "Implemented in place.\n");
  assert.match(execFileSync(process.execPath, [cli, "discard", "change"], { encoding: "utf8", cwd: root }), /Discarded 'change'/);
  assert.equal(existsSync(recordPath), false);
  assert.equal(readFileSync(join(root, "implemented.txt"), "utf8"), "implemented\n");
});

test("run in a git project creates no branch or worktree", () => {
  const root = scratchRepo("pi-run-in-place-git-");
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  execFileSync(process.execPath, [cli, "run", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      PI_BIN: writeInPlacePi(root),
      PI_RUN_HOME: makePiRunHome(root),
      WRITTEN_FILE: join(root, "implemented.txt"),
    },
  });

  const sessions = join(root, ".agents/sessions");
  const record = JSON.parse(readFileSync(sessionArtifact(sessions, "change", "pi-run.json"), "utf8"));
  assert.equal(record.kind, "in-place");
  assert.equal(record.worktree, realpathSync(root));
  assert.equal(git(root, "branch", "--list", "pi/change"), "");
  assert.equal(existsSync(join(root, ".agents/worktrees/change")), false);
});

test("resume rejects a review session", () => {
  const root = scratchRepo("pi-run-review-resume-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    fixedSessionPath(sessions, "review-1"),
    JSON.stringify({
      kind: "review",
      id: "review-1",
      command: "review",
      mainCheckout: root,
      worktree: root,
      createdAt,
    }),
  );

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "resume", "review-1", "Fix it"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_RUN_HOME: makePiRunHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read-only review session and cannot be resumed/);
});

test("plain session ids reject duplicate timestamped metadata", () => {
  const root = scratchRepo("pi-run-duplicate-session-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const record = {
    kind: "review",
    id: "duplicate",
    command: "review",
    mainCheckout: root,
    worktree: root,
    createdAt,
  };
  writeFileSync(fixedSessionPath(sessions, record.id), JSON.stringify(record));
  writeFileSync(join(sessions, "2026-01-02T00-00-00-000Z-duplicate.pi-run.json"), JSON.stringify({ ...record, createdAt: "2026-01-02T00:00:00.000Z" }));

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const listed = spawnSync(process.execPath, [cli, "sessions"], { encoding: "utf8", cwd: root });
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /Found 2 metadata files for session 'duplicate'/);

  const result = spawnSync(process.execPath, [cli, "discard", record.id], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Found 2 metadata files for session 'duplicate'/);
});

test("plain session ids do not match a longer hyphenated id", () => {
  const root = scratchRepo("pi-run-exact-session-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    fixedSessionPath(sessions, "fix-auth"),
    JSON.stringify({ kind: "review", id: "fix-auth", command: "review", mainCheckout: root, worktree: root, createdAt }),
  );

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "discard", "auth"], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown session 'auth'/);
  assert.equal(existsSync(fixedSessionPath(sessions, "fix-auth")), true);
});

test("session metadata requires a real canonical timestamp", () => {
  const root = scratchRepo("pi-run-invalid-timestamp-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, "2026-99-99T99-99-99-999Z-invalid.pi-run.json");
  writeFileSync(
    path,
    JSON.stringify({ kind: "review", id: "invalid", command: "review", mainCheckout: root, worktree: root, createdAt: "2026-99-99T99:99:99.999Z" }),
  );

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "discard", "invalid"], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Malformed session metadata/);
});

test("implement-in-worktree requires git", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-run-no-git-"));
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-run.ts"), "implement-in-worktree", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_RUN_HOME: makePiRunHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a git repository; use run for in-place work/);
});

test("failures before and during a run fail fast without burning the session id", () => {
  const root = scratchRepo("pi-run-fail-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const worktree = join(root, ".agents/worktrees/plan");
  const sessions = join(root, ".agents/sessions");
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "implement-in-worktree", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, PI_RUN_HOME: piRunHome, ...env }, timeout: 15000 });

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
  assert.equal(readdirSync(sessions).some((file) => file.endsWith("-plan.pi-run.json")), false);

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
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const crashPi = join(root, "crash-pi.mjs");
  writeFileSync(crashPi, `#!/usr/bin/env node\nprocess.exit(2);\n`);
  chmodSync(crashPi, 0o755);
  const run = (plan: string) =>
    spawnSync(process.execPath, [cli, "implement-in-worktree", plan], { encoding: "utf8", cwd: root, env: { ...process.env, PI_RUN_HOME: piRunHome, PI_BIN: crashPi }, timeout: 15000 });

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
  const output = execFileSync(process.execPath, [cli, "implement-in-worktree", "plan.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_BIN: writeBouncePi(root), PI_RUN_HOME: piRunHome, CAPTURED: captured, FIX: "1" },
  });
  assert.match(output, /Committed\./);
  assert.match(readFileSync(captured, "utf8"), /uncommitted changes/);
  const worktree = join(realpathSync(root), ".agents/worktrees/plan");
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Fix dirt");
});

test("a second unclean handback settles and reports the problem to the orchestrator", () => {
  const root = scratchRepo("pi-run-stubborn-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piRunHome = makePiRunHome(root);
  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const run = spawnSync(process.execPath, [cli, "implement-in-worktree", "plan.md"], {
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

test("resume refuses a session whose conversation log is missing", () => {
  const root = scratchRepo("pi-run-amnesia-");
  const piRunHome = makePiRunHome(root);
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const record = {
    kind: "worktree",
    id: "lost",
    command: "implement-in-worktree",
    mainCheckout: root,
    worktree: root,
    branch: "pi/lost",
    baseCommit: git(root, "rev-parse", "HEAD"),
    mergeState: { kind: "unrebased" },
    createdAt,
  };
  writeFileSync(fixedSessionPath(sessions, "lost"), JSON.stringify(record));

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const resume = spawnSync(process.execPath, [cli, "resume", "lost", "keep going"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_RUN_HOME: piRunHome },
    timeout: 15000,
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Expected one Pi JSONL for session 'lost', found 0/);
});

test("run warns once per complete interval when its event log goes silent", async () => {
  const root = scratchRepo("pi-run-stall-");
  const sessions = join(realpathSync(root), ".agents/sessions");
  const piRunHome = makePiRunHome(root);
  const plan = join(root, "stall.md");
  const fakePi = join(root, "stall-pi.mjs");
  writeFileSync(plan, "Keep running without events.");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
process.stdin.once("data", () => setInterval(() => {}, 1000));
`,
  );
  chmodSync(fakePi, 0o755);

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const child = spawn(process.execPath, [cli, "run", plan], {
    cwd: root,
    env: { ...process.env, PI_BIN: fakePi, PI_RUN_HOME: piRunHome },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const deadline = Date.now() + 15000;
  while (!existsSync(sessions) || !readdirSync(sessions).some((file) => file.endsWith("-stall.pi-run.json"))) {
    if (Date.now() > deadline) assert.fail("timed out waiting for session metadata");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const recordPath = sessionArtifact(sessions, "stall", "pi-run.json");
  const logPath = recordPath.replace(/\.pi-run\.json$/, ".log");
  writeFileSync(logPath, "events\n");
  const futureTime = new Date(Date.now() + 60 * 1000);
  utimesSync(logPath, futureTime, futureTime);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  assert.doesNotMatch(stdout, /produced no events/, "a future-dated log is not stalled");
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(logPath, staleTime, staleTime);
  const waitForWarnings = async (count: number) => {
    while ((stdout.match(/produced no events/g)?.length ?? 0) < count) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for stall warning #${count}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  };
  try {
    await waitForWarnings(1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    assert.equal(stdout.match(/produced no events/g)?.length, 1, "no repeat within the same interval");
    assert.doesNotMatch(stdout, /Last event:/, "the warning never quotes raw RPC events");

    const stalerTime = new Date(Date.now() - 16 * 60 * 1000);
    utimesSync(logPath, stalerTime, stalerTime);
    await waitForWarnings(2);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("discard removes a review session's record without touching git", () => {
  const root = scratchRepo("pi-run-direct-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const record = {
    kind: "review",
    id: "review-1",
    command: "review",
    mainCheckout: root,
    worktree: root,
    createdAt,
  };
  const recordPath = fixedSessionPath(sessions, "review-1");
  writeFileSync(recordPath, JSON.stringify(record));

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const output = execFileSync(process.execPath, [cli, "discard", "review-1"], { encoding: "utf8", cwd: root });
  assert.match(output, /Discarded 'review-1'/);
  assert.equal(existsSync(recordPath), false);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("run prints each consult question once with its answer path", async () => {
  const root = scratchRepo("pi-run-consult-");
  const sessions = join(realpathSync(root), ".agents/sessions");
  const piRunHome = makePiRunHome(root);
  const plan = join(root, "consult.md");
  const fakePi = join(root, "consult-pi.mjs");
  const question = join(sessions, "consult.question.md");
  const answer = join(sessions, "consult.answer.md");
  writeFileSync(plan, "Ask the orchestrator.");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const valueAfter = flag => process.argv[process.argv.indexOf(flag) + 1];
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  if (!input.includes("\\n")) return;
  writeFileSync(${JSON.stringify(question)}, "Which auth flow?");
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(answer)})) return;
    clearInterval(timer);
    const id = valueAfter("--session-id");
    const sessionDir = valueAfter("--session-dir");
    const message = {role:"assistant", content:[{type:"text", text:"Used the selected auth flow."}]};
    writeFileSync(join(sessionDir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({type:"session", id}) + "\\n" + JSON.stringify({type:"message", message}) + "\\n");
    console.log(JSON.stringify({type:"message_end", message}));
    console.log(JSON.stringify({type:"agent_settled"}));
  }, 50);
});
`,
  );
  chmodSync(fakePi, 0o755);

  const cli = join(import.meta.dirname, "../src/pi-run.ts");
  const child = spawn(process.execPath, [cli, "run", plan], {
    cwd: root,
    env: { ...process.env, PI_BIN: fakePi, PI_RUN_HOME: piRunHome },
  });
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
    const recordPath = sessionArtifact(sessions, "consult", "pi-run.json");
    const logPath = recordPath.replace(/\.pi-run\.json$/, ".log");
    writeFileSync(logPath, "events\n");
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(logPath, staleTime, staleTime);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    assert.doesNotMatch(stdout, /produced no events/, "a pending consult is not stalled");
    writeFileSync(answer, "Use OAuth.");
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0);
    assert.equal(stdout.match(/Which auth flow\?/g)?.length, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
