#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import { parsePrompt, renderString, renderTemplate, resolveModel, thinkingLevels, type PromptCommand } from "./core.ts";
import { git, mainCheckout, sessionIdFromPlan } from "./runner.ts";

type SessionFields = {
  id: string;
  command: string;
  mainCheckout: string;
  worktree: string;
  baseCommit: string;
  createdAt: string;
};

type Session = SessionFields &
  (
    | { kind: "worktree"; branch: string; mergeState: { kind: "unrebased" } | { kind: "rebased"; onto: string } }
    | { kind: "direct" }
  );

type Flags = {
  args: string[];
  pre: string[];
  post: string[];
  model: string | undefined;
  thinking: string | undefined;
  base: string;
};

const home = resolve(process.env.PI_RUN_HOME ?? dirname(import.meta.dirname));
const piBin = process.env.PI_BIN ?? "pi";

function fail(message: string): never {
  throw new Error(message);
}

// Model-facing text lives in prompts/strings.json, never inline in code.
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

function sessionDirs(project: string) {
  const main = mainCheckout(project);
  const sessions = join(main, ".agents", "sessions");
  const worktrees = join(main, ".agents", "worktrees");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(worktrees, { recursive: true });
  return { main, sessions, worktrees };
}

function sessionPath(sessions: string, id: string): string {
  return join(sessions, `${id}.pi-run.json`);
}

function piSessionFiles(sessions: string, id: string): string[] {
  return readdirSync(sessions).filter((file) => file.endsWith(`_${id}.jsonl`));
}

function sessionResult(sessions: string, id: string): string {
  const files = piSessionFiles(sessions, id);
  if (files.length !== 1) fail(msg("expected-one-jsonl", { id, count: String(files.length) }));
  const entries = readFileSync(join(sessions, files[0]!), "utf8").trim().split("\n").reverse();
  for (const line of entries) {
    const entry = record(JSON.parse(line), "Pi session entry");
    if (entry.type !== "message") continue;
    const message = record(entry.message, "Pi session message");
    if (typeof message.role !== "string") fail(msg("role-must-be-string", { context: "Pi session message" }));
    if (message.role !== "assistant") continue;
    const text = assistantText(entry.message);
    if (text) return text;
  }
  fail(msg("no-assistant-response", { id }));
}

function readSession(sessions: string, id: string): Session {
  const path = sessionPath(sessions, id);
  if (!existsSync(path)) fail(msg("unknown-session", { id }));
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(msg("malformed-session-metadata", { path }));
  const record = value as Record<string, unknown>;
  const common = ["id", "command", "mainCheckout", "worktree", "baseCommit", "createdAt"];
  if (common.some((field) => typeof record[field] !== "string") || record.id !== id) fail(msg("malformed-session-metadata", { path }));
  if (record.kind === "direct" && Object.keys(record).every((key) => [...common, "kind"].includes(key))) return record as Session;
  if (record.kind !== "worktree" || typeof record.branch !== "string") fail(msg("malformed-session-metadata", { path }));
  const mergeState = record.mergeState;
  if (!mergeState || typeof mergeState !== "object" || Array.isArray(mergeState)) fail(msg("malformed-session-metadata", { path }));
  const state = mergeState as Record<string, unknown>;
  const validState =
    (state.kind === "unrebased" && Object.keys(state).length === 1) ||
    (state.kind === "rebased" && typeof state.onto === "string" && Object.keys(state).length === 2);
  if (!validState || !Object.keys(record).every((key) => [...common, "kind", "branch", "mergeState"].includes(key))) {
    fail(msg("malformed-session-metadata", { path }));
  }
  return record as Session;
}

function writeSession(sessions: string, session: Session): void {
  writeFileSync(sessionPath(sessions, session.id), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function parseFlags(values: string[]): Flags {
  const flags: Flags = { args: [], pre: [], post: [], model: undefined, thinking: undefined, base: "HEAD" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!["--pre", "--post", "--model", "--thinking", "--base"].includes(value)) {
      flags.args.push(value);
      continue;
    }
    const next = values[index + 1];
    if (!next) fail(msg("requires-a-value", { flag: value }));
    if (value === "--pre") flags.pre.push(next);
    if (value === "--post") flags.post.push(next);
    if (value === "--model") flags.model = next;
    if (value === "--thinking") flags.thinking = next;
    if (value === "--base") flags.base = next;
    index += 1;
  }
  if (flags.thinking && !thinkingLevels.includes(flags.thinking as (typeof thinkingLevels)[number])) {
    fail(msg("thinking-must-be-one-of", { levels: thinkingLevels.join(", ") }));
  }
  return flags;
}

function commandFile(name: string): string {
  const path = join(home, "prompts", `${name}.md`);
  if (!existsSync(path)) {
    const names = readdirSync(join(home, "prompts")).filter((file) => file.endsWith(".md")).map((file) => basename(file, ".md"));
    fail(msg("unknown-command", { name, names: names.join(", ") }));
  }
  return path;
}

function shell(command: string, cwd: string): string {
  const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) fail(result.stderr?.trim() || msg("command-failed", { command }));
  return result.stdout.trimEnd();
}

// output-append blocks run traced (`+ command` lines interleaved with their
// output) so the orchestrator sees what produced each result without the
// prompt having to document its own commands. They are a best-effort appendix:
// a failing command's error text appears in the trace, but never fails the run
// it decorates — so blocks need no defensive guards.
function tracedShell(command: string, cwd: string): string {
  const result = spawnSync("sh", ["-c", `exec 2>&1\nset -x\n${command}`], { cwd, encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  return result.stdout.trimEnd();
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(msg("must-be-object", { context }));
  return value as Record<string, unknown>;
}

function assistantText(messageValue: unknown): string | undefined {
  const message = record(messageValue, "RPC message");
  if (typeof message.role !== "string") fail(msg("role-must-be-string", { context: "RPC message" }));
  if (message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) fail(msg("assistant-content-not-array"));
  const text: string[] = [];
  for (const value of message.content) {
    const part = record(value, "Assistant content part");
    if (part.type === "text") {
      if (typeof part.text !== "string") fail(msg("assistant-text-missing"));
      text.push(part.text);
      continue;
    }
    if (part.type === "thinking" || part.type === "toolCall") continue;
    fail(msg("unknown-assistant-content-type", { type: String(part.type) }));
  }
  return text.join("");
}

function rebaseInProgress(worktree: string): boolean {
  return existsSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]));
}

// What prevents this worktree from being handed back, phrased as a correction
// for pi. Empty string when the handback is acceptable. Only uncommitted mess is
// pi's to fix — conflicts and in-progress rebases are decisions, and decisions
// escalate to the orchestrator instead of bouncing.
function handbackBlocker(worktree: string): string {
  const status = git(worktree, ["status", "--porcelain"]);
  if (status) return msg("handback-dirty", { status });
  return "";
}

async function rpcRun(session: Session, sessions: string, command: PromptCommand, prompt: string, model: string, thinking: string): Promise<string> {
  const log = join(sessions, `${session.id}.log`);
  const control = join(sessions, `${session.id}.ctl`);
  if (Buffer.byteLength(control) > 103) fail(msg("control-socket-too-long", { path: control }));
  if (existsSync(control)) {
    const live = await new Promise<boolean>((resolveProbe) => {
      const probe = createConnection(control);
      probe.once("connect", () => { probe.destroy(); resolveProbe(true); });
      probe.once("error", () => { probe.destroy(); resolveProbe(false); });
    });
    if (live) fail(msg("session-currently-running", { id: session.id }));
    rmSync(control); // stale socket left by a crashed run
  }

  const args = [
    "--mode", "rpc",
    "--session-id", session.id,
    "--session-dir", sessions,
    "--name", session.id,
    "--model", model,
    "--thinking", thinking,
    "--extension", join(home, "extensions", "sandbox", "index.ts"),
    "--extension", join(home, "extensions", "consult.ts"),
  ];
  if (command.sandbox === "read-only") args.push("--tools", "read,bash,grep,find,ls");

  // Sessions resumed while a rebase is in progress legitimately hand
  // back an unfinished rebase; everything else must settle cleanly mergeable.
  const checkHandback =
    session.kind === "worktree" && command.sandbox === "worktree-write" && !rebaseInProgress(session.worktree);

  const child = spawn(piBin, args, {
    cwd: session.worktree,
    env: {
      ...process.env,
      PI_RUN_SANDBOX_MODE: command.sandbox,
      PI_RUN_SESSION_DIR: sessions,
      PI_RUN_SESSION_ID: session.id,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  // Pi warns "No project session found ... creating a new session" whenever
  // --session-id names a session that doesn't exist yet — which is every new
  // run, since the runner always passes a deterministic id. The full stderr
  // still goes to the log; only this known-benign line is kept off the console.
  let stderrTail = "";
  child.stderr.on("data", (chunk: string) => {
    appendFileSync(log, chunk);
    stderrTail += chunk;
    let newline;
    while ((newline = stderrTail.indexOf("\n")) !== -1) {
      const line = stderrTail.slice(0, newline + 1);
      stderrTail = stderrTail.slice(newline + 1);
      if (!line.includes("creating a new session with that id")) process.stderr.write(line);
    }
  });

  let nextId = 1;
  let abortRequested = false;
  let corrections = 0;
  const pending = new Map<string, (response: string) => void>();
  const send = (value: Record<string, unknown>): string => {
    const id = `pi-run-${nextId++}`;
    child.stdin.write(`${JSON.stringify({ id, ...value })}\n`);
    return id;
  };
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = record(JSON.parse(input.slice(0, newline)), "Control request");
      if (request.type !== "steer" && request.type !== "follow_up" && request.type !== "abort") fail(msg("unknown-control-request", { type: String(request.type) }));
      if (request.type !== "abort" && typeof request.message !== "string") fail(msg("requires-a-message", { name: request.type }));
      if (request.type === "abort" && request.message !== undefined) fail(msg("abort-no-message"));
      if (request.type === "abort") abortRequested = true;
      const id = send(request.message === undefined ? { type: request.type } : { type: request.type, message: request.message });
      pending.set(id, (response) => socket.end(`${response}\n`));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(control, resolveListen);
  });

  return await new Promise<string>((resolveRun, reject) => {
    let buffer = "";
    let state: { kind: "awaiting-result" } | { kind: "has-result"; result: string } | { kind: "settled"; result: string } | { kind: "failed" } = {
      kind: "awaiting-result",
    };
    const stop = () => {
      server.close();
      child.stdin.end();
      child.kill();
      if (existsSync(control)) rmSync(control);
    };
    const failRun = (error: unknown) => {
      if (state.kind === "failed" || state.kind === "settled") return;
      state = { kind: "failed" };
      stop();
      reject(error);
    };
    const finish = () => {
      switch (state.kind) {
        case "awaiting-result":
          if (!abortRequested) {
            failRun(new Error(msg("pi-settled-without-result")));
            return;
          }
          state = { kind: "settled", result: msg("interrupted") };
          stop();
          return;
        case "has-result":
          state = { kind: "settled", result: state.result };
          stop();
          return;
        case "failed":
        case "settled":
          return;
        default: {
          const unknownState: never = state;
          fail(msg("unknown-rpc-run-state", { state: String(unknownState) }));
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        appendFileSync(log, `${line}\n`);
        try {
          const event = record(JSON.parse(line), "RPC event");
          if (typeof event.type !== "string") fail(msg("rpc-event-type-not-string"));
          if (event.type === "response") {
            if (typeof event.success !== "boolean") fail(msg("success-must-be-boolean", { context: "RPC response" }));
            if (event.id !== undefined && typeof event.id !== "string") fail(msg("rpc-response-id-not-string"));
            if (typeof event.id === "string" && pending.has(event.id)) {
              pending.get(event.id)!(line);
              pending.delete(event.id);
            }
            if (!event.success) {
              if (typeof event.error !== "string") fail(msg("failed-response-no-error", { context: "RPC" }));
              failRun(new Error(event.error));
            }
            continue;
          }
          if (event.type === "extension_ui_request") {
            if (typeof event.id !== "string" || typeof event.method !== "string") fail(msg("malformed-extension-ui-request"));
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
            continue;
          }
          if (event.type === "message_end") {
            const message = record(event.message, "RPC message");
            if (message.stopReason === "error") {
              failRun(new Error(typeof message.errorMessage === "string" ? message.errorMessage : msg("pi-model-error-no-message")));
              return;
            }
            const text = assistantText(event.message);
            if (text) state = { kind: "has-result", result: text };
            continue;
          }
          if (event.type === "agent_settled") {
            // One correction round: bounce the first unclean handback back to
            // pi; a second one settles anyway and runPrompt reports it to the
            // orchestrator.
            if (state.kind === "has-result" && !abortRequested && checkHandback && corrections === 0 && !rebaseInProgress(session.worktree)) {
              const blocker = handbackBlocker(session.worktree);
              if (blocker) {
                corrections = 1;
                send({ type: "prompt", message: blocker });
                continue;
              }
            }
            finish();
            continue;
          }
          const informational = new Set([
            "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update",
            "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update",
            "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "extension_error",
          ]);
          if (!informational.has(event.type)) fail(msg("unknown-rpc-event", { type: event.type }));
        } catch (error) {
          failRun(error);
          return;
        }
      }
    });
    child.once("error", failRun);
    child.once("exit", (code) => {
      if (stderrTail) process.stderr.write(stderrTail);
      if (state.kind === "settled") resolveRun(state.result);
      else failRun(new Error(msg("pi-exited-before-settled", { code: String(code ?? "signal") })));
    });
    send({ type: "prompt", message: prompt });
  });
}

function composePrompt(command: PromptCommand, worktree: string, args: string[], flags: Flags): string {
  const injections: Record<string, string> = {};
  injections.base = flags.base;
  for (const [name, script] of Object.entries(command.inject)) injections[name] = shell(script, worktree);
  if (command.lifecycle === "create") {
    const plan = args[0];
    if (!plan) fail(msg("plan-file-required"));
    const planPath = resolve(plan);
    injections.plan_path = planPath;
    injections.plan = readFileSync(planPath, "utf8");
  }
  const readFiles = (paths: string[]) => paths.map((path) => readFileSync(resolve(path), "utf8")).join("\n\n");
  const guidance = command.lifecycle === "direct" ? "" : command.consult;
  return [readFiles(flags.pre), guidance, renderTemplate(command.body, command.lifecycle === "create" ? args.slice(1) : args, injections), readFiles(flags.post)]
    .filter(Boolean)
    .join("\n\n");
}

async function runPrompt(name: string, project: string, values: string[]): Promise<void> {
  const command = parsePrompt(readFileSync(commandFile(name), "utf8"));
  const flags = parseFlags(values);
  const models = JSON.parse(readFileSync(join(home, "models.json"), "utf8")) as unknown;
  const promptThinking = command.thinking.kind === "prompt" ? command.thinking.level : undefined;
  const resolvedModel = resolveModel(flags.model ?? command.model, flags.thinking ?? promptThinking, models);
  for (const path of [...flags.pre, ...flags.post]) {
    if (!existsSync(resolve(path))) fail(msg("attachment-missing", { path: resolve(path) }));
  }
  const dirs = sessionDirs(project);
  let session: Session;
  let promptArgs = flags.args;

  if (command.lifecycle === "reuse") {
    const id = flags.args[0];
    if (!id) fail(msg("requires-session-id", { name }));
    // Direct (read-only) sessions are not rejected here, so resuming one grants the
    // worktree-write sandbox to the directory the original run could only read.
    session = readSession(dirs.sessions, id);
    promptArgs = flags.args.slice(1);
    if (!existsSync(session.worktree)) fail(msg("session-worktree-missing", { worktree: session.worktree }));
    // Without its conversation JSONL, pi would silently start an amnesiac
    // session under the same id instead of resuming.
    const conversations = piSessionFiles(dirs.sessions, id);
    if (conversations.length !== 1) fail(msg("expected-one-jsonl", { id, count: String(conversations.length) }));
  } else if (command.lifecycle === "create") {
    const plan = flags.args[0];
    if (!plan) fail(msg("requires-plan-file", { name }));
    if (!existsSync(resolve(plan))) fail(msg("plan-file-missing", { path: resolve(plan) }));
    const id = sessionIdFromPlan(plan);
    if (existsSync(sessionPath(dirs.sessions, id))) fail(msg("session-already-exists", { id }));
    // A merged or discarded session leaves its conversation JSONL behind, which
    // permanently reserves the name; only "resume it" would be a lie here.
    if (piSessionFiles(dirs.sessions, id).length > 0) fail(msg("session-name-burned", { id }));
    const worktree = join(dirs.worktrees, id);
    const branch = `pi/${id}`;
    const baseCommit = git(dirs.main, ["rev-parse", "HEAD"]);
    git(dirs.main, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    session = {
      kind: "worktree",
      id,
      command: name,
      mainCheckout: dirs.main,
      worktree,
      branch,
      baseCommit,
      mergeState: { kind: "unrebased" },
      createdAt: new Date().toISOString(),
    };
    writeSession(dirs.sessions, session);
  } else {
    let worktree = project;
    if (flags.args[0] && existsSync(sessionPath(dirs.sessions, flags.args[0]))) {
      const target = readSession(dirs.sessions, flags.args[0]);
      worktree = target.worktree;
      promptArgs = flags.args.slice(1);
    }
    const id = `${name}-${Date.now()}`;
    session = {
      kind: "direct",
      id,
      command: name,
      mainCheckout: dirs.main,
      worktree,
      baseCommit: git(dirs.main, ["rev-parse", "HEAD"]),
      createdAt: new Date().toISOString(),
    };
    writeSession(dirs.sessions, session);
  }

  const prompt = composePrompt(command, session.worktree, promptArgs, flags);
  const result = await rpcRun(session, dirs.sessions, command, prompt, resolvedModel.model, resolvedModel.thinking);
  process.stdout.write(`${result}\n`);
  if (command.outputAppend) process.stdout.write(`${tracedShell(command.outputAppend, session.worktree)}\n`);
  if (session.kind === "worktree" && command.sandbox === "worktree-write") {
    if (rebaseInProgress(session.worktree)) {
      const conflicts = git(session.worktree, ["diff", "--name-only", "--diff-filter=U"]);
      process.stdout.write(`\n${msg("handback-rebase-warning", { worktree: session.worktree, conflicts })}\n`);
      return;
    }
    const blocker = handbackBlocker(session.worktree);
    if (blocker) process.stdout.write(`\n${msg("handback-warning", { worktree: session.worktree, problem: blocker })}\n`);
  }
}

function control(project: string, id: string, type: "steer" | "follow_up" | "abort", message: string): Promise<void> {
  const { sessions } = sessionDirs(project);
  readSession(sessions, id);
  const path = join(sessions, `${id}.ctl`);
  if (!existsSync(path)) fail(msg("session-not-currently-running", { id }));
  return new Promise((resolveControl, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("data", (data) => {
      const response = record(JSON.parse(data.toString()), "Control response");
      if (typeof response.success !== "boolean") fail(msg("success-must-be-boolean", { context: "Control response" }));
      if (!response.success) {
        if (typeof response.error !== "string") fail(msg("failed-response-no-error", { context: "control" }));
        reject(new Error(response.error));
      }
      else resolveControl();
    });
    socket.write(`${JSON.stringify(message ? { type, message } : { type })}\n`);
  });
}

function listSessions(project: string): void {
  const { sessions } = sessionDirs(project);
  const records = readdirSync(sessions)
    .filter((file) => file.endsWith(".pi-run.json"))
    .map((file) => readSession(sessions, file.slice(0, -".pi-run.json".length)));
  for (const record of records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    process.stdout.write(`${record.id}\t${record.command}\t${record.worktree}\n`);
  }
}

function merge(project: string, id: string): void {
  const { main, sessions } = sessionDirs(project);
  const session = readSession(sessions, id);
  if (session.kind !== "worktree") fail(msg("session-no-mergeable-branch", { id }));
  if (existsSync(git(session.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]))) {
    fail(msg("session-rebase-in-progress", { id }));
  }
  if (git(session.worktree, ["status", "--porcelain"])) {
    fail(msg("session-uncommitted-changes", { id, worktree: session.worktree }));
  }
  const mainBranch = git(main, ["branch", "--show-current"]);
  if (!mainBranch) fail(msg("main-not-on-branch"));
  const mainHead = git(main, ["rev-parse", "HEAD"]);
  if (session.mergeState.kind === "unrebased" || session.mergeState.onto !== mainHead) {
    const rebase = spawnSync("git", ["rebase", mainBranch], { cwd: session.worktree, encoding: "utf8" });
    if (rebase.status !== 0) {
      const conflicts = git(session.worktree, ["diff", "--name-only", "--diff-filter=U"]);
      fail(msg("rebase-stopped-with-conflicts", { conflicts, worktree: session.worktree, id: session.id }));
    }
    if (mainHead !== session.baseCommit) {
      session.mergeState = { kind: "rebased", onto: mainHead };
      writeSession(sessions, session);
      process.stdout.write(`${msg("rebased-onto-updated", { id, branch: mainBranch, worktree: session.worktree })}\n`);
      return;
    }
  }
  const rebasedOnto = session.mergeState.kind === "rebased" ? session.mergeState.onto : mainHead;
  if (git(main, ["rev-parse", "HEAD"]) !== rebasedOnto) fail(msg("main-moved-after-rebase"));
  if (git(session.worktree, ["rev-parse", "HEAD"]) === rebasedOnto) fail(msg("session-no-changes-to-merge", { id }));
  git(main, ["merge", "--ff-only", session.branch]);
  git(main, ["worktree", "remove", session.worktree]);
  git(main, ["branch", "-d", session.branch]);
  rmSync(sessionPath(sessions, id));
  process.stdout.write(`${msg("merged", { id, branch: mainBranch })}\n`);
}

function discard(project: string, id: string): void {
  const { main, sessions } = sessionDirs(project);
  const session = readSession(sessions, id);
  if (session.kind === "worktree") {
    git(main, ["worktree", "remove", "--force", session.worktree]);
    git(main, ["branch", "-D", session.branch]);
  }
  rmSync(sessionPath(sessions, id));
  process.stdout.write(`${msg("discarded", { id })}\n`);
}

function help(): void {
  process.stdout.write(msg("help-usage"));
  for (const file of readdirSync(join(home, "prompts")).filter((name) => name.endsWith(".md")).sort()) {
    const command = parsePrompt(readFileSync(join(home, "prompts", file), "utf8"));
    process.stdout.write(`  ${basename(file, ".md")} ${command.argumentHint}\t${command.description}\n`);
  }
  process.stdout.write(msg("help-builtins"));
}

// Lives as long as the session, not a single run: one watch covers the initial
// run and every resume, and exits when merge or discard removes the session.
async function watch(project: string, id: string): Promise<void> {
  const { sessions } = sessionDirs(project);
  readSession(sessions, id);
  const record = sessionPath(sessions, id);
  const question = join(sessions, `${id}.question.md`);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (existsSync(record)) {
    if (existsSync(question)) {
      let text: string;
      try {
        text = readFileSync(question, "utf8");
      } catch {
        continue; // answered between the existence check and the read
      }
      process.stdout.write(`${msg("question-from-session", { id, text, path: join(sessions, `${id}.answer.md`) })}\n`);
      while (existsSync(question)) await sleep(500);
    }
    await sleep(500);
  }
  process.stdout.write(`${msg("session-ended", { id })}\n`);
}

async function main(argv: string[]): Promise<void> {
  const [name, ...values] = argv;
  if (!name || name === "help") return help();
  const project = process.cwd();
  if (name === "watch") {
    const id = values[0];
    if (!id) fail(msg("requires-session-id", { name }));
    return watch(project, id);
  }
  if (name === "sessions") return listSessions(project);
  if (name === "result") {
    const id = values[0];
    if (!id) fail(msg("requires-session-id", { name }));
    const sessions = sessionDirs(project).sessions;
    process.stdout.write(`${sessionResult(sessions, id)}\n`);
    return;
  }
  if (name === "merge" || name === "discard") {
    const id = values[0];
    if (!id) fail(msg("requires-session-id", { name }));
    return name === "merge" ? merge(project, id) : discard(project, id);
  }
  if (name === "steer" || name === "queue" || name === "interrupt") {
    const id = values[0];
    if (!id) fail(msg("requires-session-id", { name }));
    const message = values.slice(1).join(" ");
    if (name !== "interrupt" && !message) fail(msg("requires-a-message", { name }));
    await control(project, id, name === "queue" ? "follow_up" : name === "interrupt" ? "abort" : "steer", message);
    return;
  }
  await runPrompt(name, project, values);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${msg("error-prefix", { message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
