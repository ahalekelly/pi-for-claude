import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createConnection, createServer as createNetServer } from "node:net";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { resolveProject, sessionIdFromPlan } from "../src/runner.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const createdAt = "2026-01-01T00:00:00.000Z";
const createdAtPrefix = "2026-01-01T00-00-00-000Z";

function fixedSessionPath(sessions: string, id: string): string {
  return join(sessions, `${createdAtPrefix}-${id}.pi-for-claude.json`);
}

function sessionArtifact(sessions: string, id: string, extension: "pi-for-claude.json"): string {
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-(.+)\\.${extension.replace(".", "\\.")}$`);
  const files = readdirSync(sessions).filter((file) => pattern.exec(file)?.[1] === id);
  assert.equal(files.length, 1);
  return join(sessions, files[0]!);
}

test("resolveProject treats a linked worktree as its own project root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-git-"));
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.email", "pi-for-claude@example.test");
  git(root, "config", "user.name", "pi-for-claude test");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  const linked = join(root, "linked");
  git(root, "worktree", "add", "-b", "topic", linked);

  assert.deepEqual(resolveProject(root), { kind: "checkout", main: realpathSync(root) });
  assert.deepEqual(resolveProject(linked), { kind: "checkout", main: realpathSync(linked) });
});

test("resolveProject resolves a submodule checkout and its linked worktrees", () => {
  const source = mkdtempSync(join(tmpdir(), "pi-for-claude-sub-src-"));
  git(source, "init", "-b", "main");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "user.email", "pi-for-claude@example.test");
  git(source, "config", "user.name", "pi-for-claude test");
  writeFileSync(join(source, "README.md"), "sub\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "initial");

  const superRoot = mkdtempSync(join(tmpdir(), "pi-for-claude-super-"));
  git(superRoot, "init", "-b", "main");
  git(superRoot, "config", "commit.gpgsign", "false");
  git(superRoot, "config", "user.email", "pi-for-claude@example.test");
  git(superRoot, "config", "user.name", "pi-for-claude test");
  git(superRoot, "-c", "protocol.file.allow=always", "submodule", "add", source, "sub");
  const sub = join(superRoot, "sub");
  assert.deepEqual(resolveProject(sub), { kind: "checkout", main: realpathSync(sub) });

  const linked = join(superRoot, "sub-linked");
  git(sub, "worktree", "add", "-b", "topic", linked);
  assert.deepEqual(resolveProject(linked), { kind: "checkout", main: realpathSync(linked) });
});

test("resolveProject rejects a bare repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-bare-"));
  git(root, "init", "--bare");
  assert.throws(() => resolveProject(root), /Bare git repositories are not supported/);
});

test("resolveProject rejects a subdirectory of a checkout instead of adopting the enclosing repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-subdir-"));
  git(root, "init", "-b", "main");
  const sub = join(root, "scratch", "tmp");
  mkdirSync(sub, { recursive: true });
  assert.throws(() => resolveProject(sub), /is inside the git checkout .* but is neither its root nor a directory the checkout ignores/);
});

test("resolveProject treats a gitignored subdirectory of a checkout as a standalone project", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-ignored-subdir-"));
  git(root, "init", "-b", "main");
  writeFileSync(join(root, ".gitignore"), "scratch/\n");
  const sub = join(root, "scratch", "tmp");
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(resolveProject(sub), { kind: "standalone", dir: sub });
});

test("resolveProject treats a directory outside every checkout as a non-git project", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-plain-"));
  assert.deepEqual(resolveProject(root), { kind: "standalone", dir: resolve(root) });
});

test("sessionIdFromPlan accepts portable plan names and rejects unsafe ones", () => {
  assert.equal(sessionIdFromPlan("plans/fix-auth.md"), "fix-auth");
  assert.throws(() => sessionIdFromPlan("plans/Bad Plan.md"), /portable session id/);
});

function scratchRepo(prefix: string): string {
  const root = mkdtempSync(`/tmp/${prefix}`);
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.email", "pi-for-claude@example.test");
  git(root, "config", "user.name", "pi-for-claude test");
  writeFileSync(join(root, ".gitignore"), ".agents/\n");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "initial");
  return root;
}

function makePiForClaudeHome(root: string): string {
  const piForClaudeHome = join(root, "pi-for-claude-home");
  mkdirSync(join(piForClaudeHome, "prompts"), { recursive: true });
  cpSync(join(import.meta.dirname, "../prompts/strings.json"), join(piForClaudeHome, "prompts/strings.json"));
  cpSync(
    join(import.meta.dirname, "../prompts/pi-for-claude-instructions.md"),
    join(piForClaudeHome, "prompts/pi-for-claude-instructions.md"),
  );
  writeFileSync(join(piForClaudeHome, "models.json"), '{"default":{"model":"test-provider/test-model","thinking":"high"}}\n');
  writeFileSync(
    join(piForClaudeHome, "prompts", "implement-in-worktree.md"),
    `---
description: Implement a plan
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: Ask when blocked
input:
  - shell: |
      printf 'Context generated before Pi runs.'
  - shell: |
      printf 'Expected input failure.' >&2
      exit 7
  - text: |
      Additional input text.
  - prompt
output:
  - text: |
      Before Pi:
  - shell: |
      echo before
  - pi
  - text: |
      After Pi:
  - shell: |
      echo after
---
Do not run git commit or git push.
$plan
`,
  );
  writeFileSync(
    join(piForClaudeHome, "prompts", "run.md"),
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
    join(piForClaudeHome, "prompts", "review.md"),
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
    join(piForClaudeHome, "prompts", "resume.md"),
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
  return piForClaudeHome;
}

type ModelReply =
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "tool"; name: string; arguments: Record<string, unknown>; delayMs?: number }
  | { kind: "error"; status: number; message: string; delayMs?: number };

function isolatedAgentDir(root: string, baseUrl = "http://127.0.0.1:1/v1"): string {
  const agentDir = join(root, `pi-agent-${Date.now()}-${Math.random()}`);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "test-provider": {
        baseUrl,
        api: "openai-completions",
        apiKey: "test-key",
        models: [{
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        }],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
  return agentDir;
}

function startModelServer(root: string, replies: ModelReply[]) {
  const serverPath = join(root, `model-server-${Date.now()}-${Math.random()}.mjs`);
  const portPath = `${serverPath}.port`;
  const requestsPath = `${serverPath}.requests`;
  writeFileSync(
    serverPath,
    `import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const replies = ${JSON.stringify(replies)};
let index = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => body += chunk);
  request.on("end", () => {
    appendFileSync(${JSON.stringify(requestsPath)}, body + "\\n");
    const reply = replies[Math.min(index++, replies.length - 1)];
    setTimeout(() => {
      if (reply.kind === "error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.message, type: "test_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = reply.kind === "text"
        ? { content: reply.text }
        : { tool_calls: [{ index: 0, id: "call-" + index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] };
      response.write("data: " + JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta, finish_reason: null }] }) + "\\n\\n");
      const finish_reason = reply.kind === "text" ? "stop" : "tool_calls";
      response.write("data: " + JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason }] }) + "\\n\\n");
      response.end("data: [DONE]\\n\\n");
    }, reply.delayMs ?? 0);
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)));
`,
  );
  const child = spawn(process.execPath, [serverPath], { stdio: "ignore" });
  const deadline = Date.now() + 5000;
  while (!existsSync(portPath)) {
    if (Date.now() > deadline) assert.fail("timed out starting model server");
    spawnSync("sleep", ["0.02"]);
  }
  const port = readFileSync(portPath, "utf8");
  const agentDir = isolatedAgentDir(root, `http://127.0.0.1:${port}/v1`);
  return {
    agentDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
    requestsPath,
    stop: () => child.kill(),
  };
}

function modelRequests(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("help ignores Markdown documentation in the prompts directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-help-"));
  const piForClaudeHome = makePiForClaudeHome(root);
  writeFileSync(join(piForClaudeHome, "prompts", "pi-for-claude-instructions.md"), "# Instructions\n");

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "help"], {
    cwd: root,
    env: { ...process.env, PI_FOR_CLAUDE_HOME: piForClaudeHome },
    encoding: "utf8",
  });
  assert.doesNotMatch(output, /pi-for-claude-instructions/);
  assert.match(output, /implement-in-worktree <plan-file>/);
});

test("a proxied environment re-execs with NODE_USE_ENV_PROXY and still works", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-proxy-"));
  const piForClaudeHome = makePiForClaudeHome(root);

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "help"], {
    cwd: root,
    env: { ...process.env, PI_FOR_CLAUDE_HOME: piForClaudeHome, HTTPS_PROXY: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "" },
    encoding: "utf8",
  });
  assert.match(output, /implement-in-worktree <plan-file>/);
});

test("run creates an isolated worktree and sends the composed prompt through the SDK", (t) => {
  const root = scratchRepo("pi-for-claude-e2e-");
  writeFileSync(join(root, "fix-auth.md"), "Fix the auth flow.\n");
  const model = startModelServer(root, [{ kind: "text", text: "Implemented auth." }]);
  t.after(model.stop);

  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "fix-auth.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });

  const worktree = join(realpathSync(root), ".agents/worktrees/fix-auth");
  assert.match(output, /Before Pi:\n\+ echo before\nbefore\nImplemented auth\.\nAfter Pi:\n\+ echo after\nafter/);
  assert.match(output, /WARNING: Input shell command failed \(exit 7\), but the run is continuing anyway\./);
  assert.equal(git(worktree, "branch", "--show-current"), "pi/fix-auth");
  const request = JSON.stringify(modelRequests(model.requestsPath)[0]);
  assert.match(request, /Context generated before Pi runs/);
  assert.match(request, /Expected input failure/);
  assert.match(request, /Additional input text/);
  assert.match(request, /Fix the auth flow/);
  assert.match(request, /Do not run git commit or git push/);
  assert.deepEqual(readdirSync(model.agentDir).sort(), ["auth.json", "models-store.json", "models.json", "settings.json"]);

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
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

test("view exports once by default and live-reloads with --live", async (t) => {
  const root = realpathSync(scratchRepo("pi-for-claude-view-"));
  const sessions = join(root, ".agents", "sessions");
  const commands = join(root, "commands");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(commands);
  const source = join(sessions, "2026-01-01T00-00-00-000Z_view-me.jsonl");
  const output = join(sessions, "2026-01-01T00-00-00-000Z_view-me.html");
  const opened = join(root, "opened.txt");
  writeFileSync(source, "session data\n");

  const fakePi = join(commands, "pi.mjs");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] !== "--export") process.exit(2);
writeFileSync(process.argv[4], "<body>exported: " + readFileSync(process.argv[3], "utf8") + "</body>");
console.log("Exported to: " + process.argv[4]);
`,
  );
  chmodSync(fakePi, 0o755);
  const fakeOpen = join(commands, "open");
  writeFileSync(fakeOpen, `#!/bin/sh\nprintf '%s' "$1" > "$OPENED_PATH"\n`);
  chmodSync(fakeOpen, 0o755);

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const env = { ...process.env, PI_BIN: fakePi, OPENED_PATH: opened, PATH: `${commands}:${process.env.PATH}` };
  const exported = execFileSync(process.execPath, [cli, "view", "view-me", "--no-open"], { cwd: root, env, encoding: "utf8" });
  assert.equal(exported, `Exported to: ${output}\n`);
  assert.equal(readFileSync(output, "utf8"), "<body>exported: session data\n</body>");
  assert.equal(existsSync(opened), false);

  execFileSync(process.execPath, [cli, "view", "view-me"], { cwd: root, env });
  assert.equal(readFileSync(opened, "utf8"), output);

  const viewed = spawn(process.execPath, [cli, "view", "view-me", "--live"], { cwd: root, env });
  t.after(() => viewed.kill());
  for (let attempts = 0; !readFileSync(opened, "utf8").startsWith("http://") && attempts < 100; attempts += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(existsSync(opened), true);
  const url = readFileSync(opened, "utf8");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(await (await fetch(url)).text(), /new EventSource\("\/events"\)/);

  const events = await fetch(`${url}events`);
  const reader = events.body!.getReader();
  await reader.read();
  appendFileSync(source, "more data\n");
  const update = await reader.read();
  assert.equal(new TextDecoder().decode(update.value), "data: reload\n\n");
  assert.equal(readFileSync(output, "utf8"), "<body>exported: session data\nmore data\n</body>");
  await reader.cancel();
  viewed.kill();
  await new Promise((resolveExit) => viewed.once("exit", resolveExit));
});

test("view requires exactly one matching session JSONL", () => {
  const root = realpathSync(scratchRepo("pi-for-claude-view-count-"));
  const sessions = join(root, ".agents", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "first_same.jsonl"), "first\n");
  writeFileSync(join(sessions, "second_same.jsonl"), "second\n");

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "view", "same", "--no-open"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected one Pi JSONL for session 'same', found 2/);
});

test("view uses the packaged Pi instead of a PATH executable", () => {
  const root = realpathSync(scratchRepo("pi-for-claude-packaged-pi-"));
  const sessions = join(root, ".agents", "sessions");
  const commands = join(root, "commands");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(commands);
  const source = join(sessions, "2026-01-01T00-00-00-000Z_packaged-pi.jsonl");
  const output = join(sessions, "2026-01-01T00-00-00-000Z_packaged-pi.html");
  writeFileSync(source, `${JSON.stringify({ type: "session", version: 3, id: "packaged-pi", timestamp: createdAt, cwd: root })}\n`);

  const pathPi = join(commands, "pi");
  writeFileSync(pathPi, "#!/bin/sh\nexit 99\n");
  chmodSync(pathPi, 0o755);

  execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "view", "packaged-pi", "--no-open"], {
    cwd: root,
    env: { ...process.env, PI_BIN: undefined, PATH: `${commands}:${process.env.PATH}` },
  });
  assert.equal(existsSync(output), true);
});

test("SDK sessions expose the sandboxed tool allowlist in every mode", (t) => {
  const root = scratchRepo("pi-for-claude-tools-");
  const model = startModelServer(root, [
    { kind: "text", text: "worktree" },
    { kind: "text", text: "in place" },
    { kind: "text", text: "review" },
  ]);
  t.after(model.stop);
  const env = { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) };
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  writeFileSync(join(root, "worktree.md"), "Do the thing.\n");
  writeFileSync(join(root, "in-place.md"), "Do the thing.\n");
  execFileSync(process.execPath, [cli, "implement-in-worktree", "worktree.md"], { cwd: root, env });
  execFileSync(process.execPath, [cli, "run", "in-place.md"], { cwd: root, env });
  execFileSync(process.execPath, [cli, "review"], { cwd: root, env });

  const toolNames = (request: Record<string, unknown>) => (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  const [worktree, inPlace, review] = modelRequests(model.requestsPath).map(toolNames);
  const writeTools = ["read", "bash", "write", "edit", "grep", "find", "ls", "consult_orchestrator", "web_search", "fetch_content", "get_search_content", "agent_browser"];
  assert.deepEqual(worktree, writeTools);
  assert.deepEqual(inPlace, writeTools);
  assert.deepEqual(review, writeTools.filter((name) => name !== "write" && name !== "edit"));
});

test("--no-consult removes the consult tool and swaps the guidance", (t) => {
  const root = scratchRepo("pi-for-claude-no-consult-");
  writeFileSync(join(root, "task.md"), "Do the thing.\n");
  const model = startModelServer(root, [{ kind: "text", text: "done" }]);
  t.after(model.stop);

  execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "run", "task.md", "--no-consult"], {
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });

  const request = modelRequests(model.requestsPath)[0]!;
  const toolNames = (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.equal(toolNames.includes("consult_orchestrator"), false);
  const text = JSON.stringify(request);
  assert.doesNotMatch(text, /Ask when blocked/);
  assert.match(text, /This run is unattended/);
});

test("sandboxed bash cannot read Pi credentials but can read a project file", (t) => {
  const root = scratchRepo("pi-for-claude-auth-sandbox-");
  writeFileSync(join(root, "check.md"), "Check file access.\n");
  writeFileSync(join(root, "safe.txt"), "PROJECT_FILE_MARKER\n");
  const model = startModelServer(root, [
    { kind: "tool", name: "bash", arguments: { command: "cat \"$PI_CODING_AGENT_DIR/auth.json\"" } },
    { kind: "tool", name: "bash", arguments: { command: "cat safe.txt" } },
    { kind: "text", text: "Checked access." },
  ]);
  t.after(model.stop);
  writeFileSync(join(model.agentDir, "auth.json"), JSON.stringify({ "unused-provider": { type: "api_key", key: "AUTH_SECRET_MARKER" } }));

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "run", "check.md"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const requests = modelRequests(model.requestsPath).map((request) => JSON.stringify(request));
  assert.equal(requests.some((request) => request.includes("AUTH_SECRET_MARKER")), false);
  assert.match(requests[2]!, /PROJECT_FILE_MARKER/);
});

test("run edits a non-git project in place and discard preserves its files", (t) => {
  const root = mkdtempSync("/tmp/pi-for-claude-in-place-non-git-");
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const model = startModelServer(root, [
    { kind: "tool", name: "bash", arguments: { command: "printf 'implemented\\n' > implemented.txt" } },
    { kind: "text", text: "Implemented in place." },
  ]);
  t.after(model.stop);
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const output = execFileSync(process.execPath, [cli, "run", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });

  const sessions = join(root, ".agents/sessions");
  const recordPath = sessionArtifact(sessions, "change", "pi-for-claude.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const prefix = record.createdAt.replaceAll(":", "-").replaceAll(".", "-");
  assert.equal(basename(recordPath), `${prefix}-change.pi-for-claude.json`);
  const log = readFileSync(join(sessions, `${prefix}-change.log`), "utf8");
  assert.match(log, /Implemented in place\./);
  assert.match(log, /Session settled\.\n$/);
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

test("run in a git project creates no branch or worktree", (t) => {
  const root = scratchRepo("pi-for-claude-in-place-git-");
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const model = startModelServer(root, [{ kind: "text", text: "Done." }]);
  t.after(model.stop);
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  execFileSync(process.execPath, [cli, "run", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });

  const sessions = join(root, ".agents/sessions");
  const record = JSON.parse(readFileSync(sessionArtifact(sessions, "change", "pi-for-claude.json"), "utf8"));
  assert.equal(record.kind, "in-place");
  assert.equal(record.worktree, realpathSync(root));
  assert.equal(git(root, "branch", "--list", "pi/change"), "");
  assert.equal(existsSync(join(root, ".agents/worktrees/change")), false);
});

test("a linked worktree is its own project: sessions, pi worktrees, and merge stay inside it", (t) => {
  const root = realpathSync(scratchRepo("pi-for-claude-worktree-launch-"));
  const linked = join(root, "linked");
  git(root, "worktree", "add", "-b", "topic", linked);
  writeFileSync(join(linked, "topic.txt"), "topic\n");
  git(linked, "add", "topic.txt");
  git(linked, "commit", "-m", "Topic base");
  writeFileSync(join(linked, "fix-auth.md"), "Fix the auth flow.\n");
  const model = startModelServer(linked, [{ kind: "text", text: "Implemented auth." }]);
  t.after(model.stop);

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  execFileSync(process.execPath, [cli, "implement-in-worktree", "fix-auth.md"], {
    encoding: "utf8",
    cwd: linked,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(linked) },
  });

  const worktree = join(linked, ".agents/worktrees/fix-auth");
  const record = JSON.parse(readFileSync(sessionArtifact(join(linked, ".agents/sessions"), "fix-auth", "pi-for-claude.json"), "utf8"));
  assert.equal(record.mainCheckout, linked);
  assert.equal(record.baseCommit, git(linked, "rev-parse", "HEAD"));
  assert.equal(existsSync(join(root, ".agents")), false, "the shared checkout keeps no session state for a worktree launch");
  assert.equal(existsSync(join(worktree, "topic.txt")), true, "the session branches from the launch worktree's HEAD");

  writeFileSync(join(worktree, "auth.txt"), "fixed\n");
  git(worktree, "add", "auth.txt");
  git(worktree, "commit", "-m", "Fix auth flow");

  assert.match(execFileSync(process.execPath, [cli, "merge", "fix-auth"], { encoding: "utf8", cwd: linked }), /Merged 'fix-auth'/);
  assert.equal(git(linked, "branch", "--show-current"), "topic");
  assert.equal(readFileSync(join(linked, "auth.txt"), "utf8"), "fixed\n");
  assert.equal(git(root, "log", "-1", "--format=%s"), "initial", "the shared checkout's branch is untouched");
  assert.equal(existsSync(join(root, "auth.txt")), false);
});

test("resume rejects a review session", () => {
  const root = scratchRepo("pi-for-claude-review-resume-");
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

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "resume", "review-1", "Fix it"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir(root), PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read-only review session and cannot be resumed/);
});

test("plain session ids reject duplicate timestamped metadata", () => {
  const root = scratchRepo("pi-for-claude-duplicate-session-");
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
  writeFileSync(join(sessions, "2026-01-02T00-00-00-000Z-duplicate.pi-for-claude.json"), JSON.stringify({ ...record, createdAt: "2026-01-02T00:00:00.000Z" }));

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
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
  const root = scratchRepo("pi-for-claude-exact-session-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    fixedSessionPath(sessions, "fix-auth"),
    JSON.stringify({ kind: "review", id: "fix-auth", command: "review", mainCheckout: root, worktree: root, createdAt }),
  );

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "discard", "auth"], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown session 'auth'/);
  assert.equal(existsSync(fixedSessionPath(sessions, "fix-auth")), true);
});

test("session metadata requires a real canonical timestamp", () => {
  const root = scratchRepo("pi-for-claude-invalid-timestamp-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, "2026-99-99T99-99-99-999Z-invalid.pi-for-claude.json");
  writeFileSync(
    path,
    JSON.stringify({ kind: "review", id: "invalid", command: "review", mainCheckout: root, worktree: root, createdAt: "2026-99-99T99:99:99.999Z" }),
  );

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "discard", "invalid"], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Malformed session metadata/);
});

test("implement-in-worktree requires git", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-for-claude-no-git-"));
  writeFileSync(join(root, "change.md"), "Create a file.\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "change.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir(root), PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a git repository; use run for in-place work/);
});

test("implement-in-worktree treats a gitignored subdirectory of a checkout as non-git", () => {
  const root = scratchRepo("pi-for-claude-ignored-gate-");
  writeFileSync(join(root, ".gitignore"), ".agents/\nscratch/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore scratch");
  const sub = join(root, "scratch", "tmp");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "change.md"), "Create a file.\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "change.md"], {
    encoding: "utf8",
    cwd: sub,
    env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir(root), PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a git repository; use run for in-place work/);
});

test("session launch preflight leaves no auth lock behind", () => {
  const root = scratchRepo("pi-for-claude-preflight-clean-");
  const agentDir = isolatedAgentDir(root);
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "plan.md", "--model", "missing"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown model label/);
  assert.equal(existsSync(join(agentDir, "auth.json.lock")), false);
});

test("session launch fails its auth write preflight before creating artifacts", { skip: process.platform === "win32" }, () => {
  const root = scratchRepo("pi-for-claude-preflight-denied-");
  const agentDir = isolatedAgentDir(root);
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  chmodSync(agentDir, 0o555);
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "plan.md"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /auth\.json/);
    assert.match(result.stderr, /auth\.json\.lock/);
    assert.match(result.stderr, /pi-for-claude setup/);
    assert.equal(existsSync(join(root, ".agents")), false);
  } finally {
    chmodSync(agentDir, 0o755);
  }
});

test("failures before and during a run fail fast without burning the session id", (t) => {
  const root = scratchRepo("pi-for-claude-fail-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const piForClaudeHome = makePiForClaudeHome(root);
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const worktree = join(root, ".agents/worktrees/plan");
  const sessions = join(root, ".agents/sessions");
  const model = startModelServer(root, [{ kind: "error", status: 429, message: "The usage limit has been reached" }]);
  t.after(model.stop);
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "implement-in-worktree", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: piForClaudeHome, ...env }, timeout: 15000 });

  const badModel = run({}, "plan.md", "--model", "nope");
  assert.equal(badModel.status, 1);
  assert.match(badModel.stderr, /Unknown model label 'nope'/);
  const missingPlan = run({}, "absent.md");
  assert.equal(missingPlan.status, 1);
  assert.match(missingPlan.stderr, /Plan file does not exist/);
  const missingAttachment = run({}, "plan.md", "--prepend", "absent.txt");
  assert.equal(missingAttachment.status, 1);
  assert.match(missingAttachment.stderr, /Attachment file does not exist/);
  assert.equal(existsSync(worktree), false);
  assert.equal(readdirSync(sessions).some((file) => file.endsWith("-plan.pi-for-claude.json")), false);

  writeFileSync(join(root, "plan2.md"), "Do the thing.\n");
  const provider = run(model.env, "plan2.md");
  assert.equal(provider.signal, null, "pi-for-claude must exit on its own instead of hanging");
  assert.equal(provider.status, 1);
  assert.match(provider.stderr, /The usage limit has been reached/);
});

test("steer, queue, and interrupt authenticate over the control port", async (t) => {
  const root = scratchRepo("pi-for-claude-control-");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(fixedSessionPath(sessions, "controlled"), JSON.stringify({
    kind: "in-place",
    id: "controlled",
    command: "run",
    mainCheckout: root,
    worktree: root,
    createdAt,
  }));
  const requests: unknown[] = [];
  const server = createNetServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      requests.push(JSON.parse(input.slice(0, newline)));
      socket.end('{"success":true}\n');
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const token = "a".repeat(64);
  writeFileSync(join(sessions, "controlled.ctl"), JSON.stringify({ port: address.port, token }));
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const runControl = (...args: string[]) => new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${args[0]} exited ${code}`)));
  });

  await runControl("steer", "controlled", "redirect");
  await runControl("queue", "controlled", "then verify");
  await runControl("interrupt", "controlled");
  assert.deepEqual(requests, [
    { type: "steer", message: "redirect", token },
    { type: "follow_up", message: "then verify", token },
    { type: "abort", token },
  ]);
});

test("a live control port blocks a new run; a stale one is cleaned up", async (t) => {
  const root = scratchRepo("pi-for-claude-guard-");
  const piForClaudeHome = makePiForClaudeHome(root);
  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const sessions = join(root, ".agents/sessions");
  mkdirSync(sessions, { recursive: true });
  const model = startModelServer(root, [{ kind: "text", text: "Done." }]);
  t.after(model.stop);
  const run = (plan: string) =>
    spawnSync(process.execPath, [cli, "implement-in-worktree", plan], { encoding: "utf8", cwd: root, env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: piForClaudeHome }, timeout: 15000 });

  writeFileSync(join(root, "live.md"), "Do the thing.\n");
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address !== "string");
  writeFileSync(join(sessions, "live.ctl"), JSON.stringify({ port: address.port, token: "a".repeat(64) }));
  try {
    const blocked = run("live.md");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Session 'live' is currently running/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  writeFileSync(join(root, "stale.md"), "Do the thing.\n");
  writeFileSync(join(sessions, "stale.ctl"), JSON.stringify({ port: address.port, token: "b".repeat(64) }));
  const proceeded = run("stale.md");
  assert.equal(proceeded.status, 0, proceeded.stderr);
  assert.match(proceeded.stdout, /Done\./, "the stale port must be removed so the run reaches the model");

  writeFileSync(join(root, "malformed.md"), "Do the thing.\n");
  writeFileSync(join(sessions, "malformed.ctl"), "not json");
  const malformed = run("malformed.md");
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.match(malformed.stdout, /Done\./, "an unparseable control file must be treated as stale");
});

test("a wrong control token is refused without steering the session", async (t) => {
  const root = scratchRepo("pi-for-claude-control-token-");
  const plan = join(root, "token.md");
  const sessions = join(root, ".agents/sessions");
  writeFileSync(plan, "Do the thing.\n");
  const model = startModelServer(root, [{ kind: "text", text: "Done.", delayMs: 500 }]);
  t.after(model.stop);
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "run", plan], {
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  const controlPath = join(sessions, "token.ctl");
  const deadline = Date.now() + 10000;
  while (!existsSync(controlPath)) {
    if (Date.now() > deadline) assert.fail("timed out waiting for control file");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  const location = JSON.parse(readFileSync(controlPath, "utf8")) as { port: number; token: string };
  assert.match(location.token, /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") assert.equal(statSync(controlPath).mode & 0o777, 0o600);
  const response = await new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: location.port });
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("data", resolveResponse);
    socket.write(`${JSON.stringify({ type: "steer", message: "Do something else", token: "0".repeat(64) })}\n`);
  });
  assert.deepEqual(JSON.parse(response), { success: false, error: "Invalid control token" });

  const exit = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  assert.equal(exit, 0);
  assert.equal(modelRequests(model.requestsPath).length, 1, "the refused request must not reach the model");
});

test("an unclean handback bounces back to pi until it merges cleanly", (t) => {
  const root = scratchRepo("pi-for-claude-bounce-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const model = startModelServer(root, [
    { kind: "tool", name: "bash", arguments: { command: "printf 'dirt\\n' > dirt.txt" } },
    { kind: "text", text: "Left dirt." },
    { kind: "tool", name: "bash", arguments: { command: "git add -A && git commit -m 'Fix dirt'" } },
    { kind: "text", text: "Committed." },
  ]);
  t.after(model.stop);
  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "plan.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  assert.match(output, /Committed\./);
  assert.match(JSON.stringify(modelRequests(model.requestsPath)[2]), /uncommitted changes/);
  const worktree = join(realpathSync(root), ".agents/worktrees/plan");
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Fix dirt");
});

test("a second unclean handback settles and reports the problem to the orchestrator", (t) => {
  const root = scratchRepo("pi-for-claude-stubborn-");
  writeFileSync(join(root, "plan.md"), "Do the thing.\n");
  const model = startModelServer(root, [
    { kind: "tool", name: "bash", arguments: { command: "printf 'dirt\\n' > dirt.txt" } },
    { kind: "text", text: "Left dirt." },
    { kind: "text", text: "Still dirty." },
  ]);
  t.after(model.stop);
  const run = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "implement-in-worktree", "plan.md"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
    timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Still dirty\./);
  assert.match(run.stdout, /WARNING: the session did not hand back cleanly/);
  assert.match(run.stdout, /dirt\.txt/);
});

test("resume refuses a session whose conversation log is missing", () => {
  const root = scratchRepo("pi-for-claude-amnesia-");
  const piForClaudeHome = makePiForClaudeHome(root);
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

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const resume = spawnSync(process.execPath, [cli, "resume", "lost", "keep going"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir(root), PI_FOR_CLAUDE_HOME: piForClaudeHome },
    timeout: 15000,
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Expected one Pi JSONL for session 'lost', found 0/);
});

test("run warns when the SDK event stream goes silent", () => {
  const root = scratchRepo("pi-for-claude-stall-");
  const plan = join(root, "stall.md");
  writeFileSync(plan, "Keep running without events.");
  const model = startModelServer(root, [{ kind: "text", text: "Finished.", delayMs: 2000 }]);
  // Fake a stall by jumping Date.now +6min once the model server has received
  // the request (it appends to requestsPath on arrival, before the delayed
  // reply). That lands the jump after every prompt-submission event has set
  // lastEventAt and before any response event resets it, with no assumption
  // about how long CLI startup takes.
  const clock = join(root, "advance-clock.mjs");
  writeFileSync(clock, `import { existsSync } from "node:fs";
const real = Date.now.bind(Date);
let jumped = false;
Date.now = () => {
  if (!jumped) jumped = existsSync(${JSON.stringify(model.requestsPath)});
  return real() + (jumped ? 360000 : 0);
};
`);
  try {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "run", plan], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root), NODE_OPTIONS: `--import=${clock}` },
      timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.match(/produced no events/g)?.length, 1);
    assert.doesNotMatch(run.stdout, /Last event:/);
  } finally {
    model.stop();
  }
});

test("discard removes a review session's record without touching git", () => {
  const root = scratchRepo("pi-for-claude-direct-");
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

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const output = execFileSync(process.execPath, [cli, "discard", "review-1"], { encoding: "utf8", cwd: root });
  assert.match(output, /Discarded 'review-1'/);
  assert.equal(existsSync(recordPath), false);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("watch follows a session launched outside a Monitor and exits when it settles", async (t) => {
  const root = scratchRepo("pi-for-claude-watch-");
  const plan = join(root, "watched.md");
  writeFileSync(plan, "Do the thing.");
  const model = startModelServer(root, [{ kind: "text", text: "Watched result.", delayMs: 1500 }]);
  t.after(model.stop);

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const env = { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) };
  const run = spawn(process.execPath, [cli, "run", plan], { cwd: root, env, stdio: "ignore" });

  const deadline = Date.now() + 15000;
  const waitUntil = async (predicate: () => boolean, what: string) => {
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  };

  try {
    const sessions = join(realpathSync(root), ".agents/sessions");
    await waitUntil(() => existsSync(sessions) && readdirSync(sessions).some((file) => file.endsWith(".log")), "the session log");
    const watch = spawn(process.execPath, [cli, "watch", "watched"], { cwd: root, env });
    let stdout = "";
    watch.stdout.setEncoding("utf8");
    watch.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    try {
      const exitCode = await new Promise<number | null>((resolveExit) => watch.once("exit", resolveExit));
      assert.equal(exitCode, 0);
      assert.match(stdout, /Watched result\./);
      assert.match(stdout, /Session settled\./);
    } finally {
      if (watch.exitCode === null) watch.kill("SIGKILL");
    }
  } finally {
    if (run.exitCode === null) run.kill("SIGKILL");
  }
});

test("run prints each consult question once with its answer path", async (t) => {
  const root = scratchRepo("pi-for-claude-consult-");
  const sessions = join(realpathSync(root), ".agents/sessions");
  const plan = join(root, "consult.md");
  const answer = join(sessions, "consult.answer.md");
  writeFileSync(plan, "Ask the orchestrator.");
  const model = startModelServer(root, [
    { kind: "tool", name: "consult_orchestrator", arguments: { question: "Which auth flow?" } },
    { kind: "text", text: "Used the selected auth flow." },
  ]);
  t.after(model.stop);

  const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
  const child = spawn(process.execPath, [cli, "run", plan], {
    cwd: root,
    env: { ...process.env, ...model.env, PI_FOR_CLAUDE_HOME: makePiForClaudeHome(root) },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const deadline = Date.now() + 15000;
  const waitUntil = async (predicate: () => boolean) => {
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail("timed out waiting for consult output");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  };

  try {
    await waitUntil(() => stdout.includes("Which auth flow?"));
    assert.match(stdout, new RegExp(`Answer by writing ${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    writeFileSync(answer, "Use OAuth.");
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0);
    assert.equal(stdout.match(/Which auth flow\?/g)?.length, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a permission error creating session state explains the sandbox and the unsandboxed relaunch", () => {
  const root = mkdtempSync("/tmp/pi-for-claude-eperm-");
  chmodSync(root, 0o500);
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/pi-for-claude.ts"), "sessions"], {
      encoding: "utf8",
      cwd: root,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EACCES|EPERM/);
    assert.match(result.stderr, /Relaunch outside the sandbox/);
    assert.match(result.stderr, /pi-for-claude watch <session>/);
  } finally {
    chmodSync(root, 0o700);
  }
});
