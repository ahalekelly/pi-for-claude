#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createConnection, createServer } from "node:net";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { parsePrompt, renderString, renderTemplate, resolveModel, thinkingLevels, type PromptCommand } from "./core.ts";
import { locklessSettings, refreshInstructions } from "./instructions.ts";
import { git, isGitRepository, mainCheckout, sessionIdFromPlan } from "./runner.ts";

type SessionFields = {
  id: string;
  command: string;
  mainCheckout: string;
  worktree: string;
  createdAt: string;
};

type Session = SessionFields &
  (
    | { kind: "worktree"; baseCommit: string; branch: string; mergeState: { kind: "unrebased" } | { kind: "rebased"; onto: string } }
    | { kind: "in-place" }
    | { kind: "review" }
  );

type Flags = {
  args: string[];
  prepend: string[];
  append: string[];
  model: string | undefined;
  thinking: string | undefined;
  base: string;
};

const home = resolve(process.env.PI_FOR_CLAUDE_HOME ?? dirname(import.meta.dirname));
// Extensions are package code, not configuration: they import from src/ and
// node_modules relative to their real location, so they always load from the
// package itself even when PI_FOR_CLAUDE_HOME points prompts elsewhere.
const packageExtensions = join(dirname(import.meta.dirname), "extensions");
const piPackage = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piBin = process.env.PI_BIN ?? join(dirname(piPackage), "cli.js");
const webAccessPackage = dirname(fileURLToPath(import.meta.resolve("pi-web-access/package.json")));
const browserPackage = dirname(fileURLToPath(import.meta.resolve("pi-agent-browser-native/package.json")));
const agentBrowserPackage = dirname(fileURLToPath(import.meta.resolve("agent-browser/package.json")));

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

function sessionPrefix(session: SessionFields): string {
  return `${session.createdAt.replaceAll(":", "-").replaceAll(".", "-")}-${session.id}`;
}

function findSessionPath(sessions: string, id: string): string | undefined {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.pi-for-claude\.json$/;
  const files = readdirSync(sessions).filter((file) => pattern.exec(file)?.[1] === id);
  if (files.length > 1) fail(msg("duplicate-session-metadata", { id, count: String(files.length) }));
  return files[0] ? join(sessions, files[0]) : undefined;
}

function sessionPath(sessions: string, id: string): string {
  const path = findSessionPath(sessions, id);
  if (!path) fail(msg("unknown-session", { id }));
  return path;
}

function piSessionFiles(sessions: string, id: string): string[] {
  return readdirSync(sessions).filter((file) => file.endsWith(`_${id}.jsonl`));
}

function piSessionPath(sessions: string, id: string): string {
  const files = piSessionFiles(sessions, id);
  if (files.length !== 1) fail(msg("expected-one-jsonl", { id, count: String(files.length) }));
  return join(sessions, files[0]!);
}

function sessionResult(sessions: string, id: string): string {
  const entries = readFileSync(piSessionPath(sessions, id), "utf8").trim().split("\n").reverse();
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

function readSessionFile(path: string): Session {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(msg("malformed-session-metadata", { path }));
  const record = value as Record<string, unknown>;
  const common = ["id", "command", "mainCheckout", "worktree", "createdAt"];
  if (common.some((field) => typeof record[field] !== "string")) fail(msg("malformed-session-metadata", { path }));
  const hasOnly = (fields: string[]) => Object.keys(record).every((key) => fields.includes(key));
  let session: Session;
  if (record.kind === "in-place" && hasOnly([...common, "kind"])) session = record as Session;
  else if (record.kind === "review" && hasOnly([...common, "kind"])) session = record as Session;
  else {
    if (record.kind !== "worktree" || typeof record.baseCommit !== "string" || typeof record.branch !== "string") {
      fail(msg("malformed-session-metadata", { path }));
    }
    const mergeState = record.mergeState;
    if (!mergeState || typeof mergeState !== "object" || Array.isArray(mergeState)) fail(msg("malformed-session-metadata", { path }));
    const state = mergeState as Record<string, unknown>;
    const validState =
      (state.kind === "unrebased" && Object.keys(state).length === 1) ||
      (state.kind === "rebased" && typeof state.onto === "string" && Object.keys(state).length === 2);
    if (!validState || !hasOnly([...common, "kind", "baseCommit", "branch", "mergeState"])) {
      fail(msg("malformed-session-metadata", { path }));
    }
    session = record as Session;
  }
  const timestamp = Date.parse(session.createdAt);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(session.id) || Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== session.createdAt) {
    fail(msg("malformed-session-metadata", { path }));
  }
  if (basename(path) !== `${sessionPrefix(session)}.pi-for-claude.json`) fail(msg("malformed-session-metadata", { path }));
  return session;
}

function readSession(sessions: string, id: string): Session {
  const path = sessionPath(sessions, id);
  const session = readSessionFile(path);
  if (session.id !== id) fail(msg("malformed-session-metadata", { path }));
  return session;
}

function writeSession(sessions: string, session: Session): void {
  writeFileSync(join(sessions, `${sessionPrefix(session)}.pi-for-claude.json`), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function parseFlags(values: string[]): Flags {
  const flags: Flags = { args: [], prepend: [], append: [], model: undefined, thinking: undefined, base: "HEAD" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!["--prepend", "--append", "--model", "--thinking", "--base"].includes(value)) {
      flags.args.push(value);
      continue;
    }
    const next = values[index + 1];
    if (!next) fail(msg("requires-a-value", { flag: value }));
    if (value === "--prepend") flags.prepend.push(next);
    if (value === "--append") flags.append.push(next);
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

function commandFiles(): string[] {
  const prompts = join(home, "prompts");
  return readdirSync(prompts).filter((file) => file.endsWith(".md") && readFileSync(join(prompts, file), "utf8").startsWith("---\n"));
}

function commandFile(name: string): string {
  const file = `${name}.md`;
  const files = commandFiles();
  if (!files.includes(file)) {
    const names = files.map((candidate) => basename(candidate, ".md"));
    fail(msg("unknown-command", { name, names: names.join(", ") }));
  }
  return join(home, "prompts", file);
}

function shell(command: string, cwd: string): string {
  const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) fail(result.stderr?.trim() || msg("command-failed", { command }));
  return result.stdout.trimEnd();
}

function bestEffortInputShell(command: string, cwd: string): string {
  const result = spawnSync("sh", ["-c", `exec 2>&1\n${command}`], { cwd, encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  const output = result.stdout.trimEnd();
  if (result.status === 0) return output;
  const status = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  const failure = msg("input-shell-failed", { command, status, output: output || msg("no-command-output") });
  process.stdout.write(`${failure}\n`);
  return failure;
}

// Output shell blocks run traced (`+ command` lines interleaved with their
// output) so the orchestrator sees what produced each result. They are
// best-effort: a failing command's error text appears in the trace, but never
// fails the run they decorate.
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
  const message = record(messageValue, "Pi message");
  if (typeof message.role !== "string") fail(msg("role-must-be-string", { context: "Pi message" }));
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

async function sdkRun(session: Session, sessions: string, command: PromptCommand, prompt: string, modelName: string, thinking: string): Promise<string> {
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

  const executablePath = process.env.PATH;
  if (!executablePath) fail(msg("path-required"));
  process.chdir(session.worktree);
  process.env.PI_FOR_CLAUDE_SANDBOX_MODE = command.sandbox;
  process.env.PI_FOR_CLAUDE_SESSION_DIR = sessions;
  process.env.PI_FOR_CLAUDE_SESSION_ID = session.id;
  process.env.PI_FOR_CLAUDE_SYSTEM_PATH = executablePath;
  process.env.PATH = `${join(dirname(agentBrowserPackage), ".bin")}${delimiter}${executablePath}`;

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = locklessSettings(session.worktree, agentDir);
  const separator = modelName.indexOf("/");
  if (separator === -1) fail(msg("unknown-model", { model: modelName }));
  const model = modelRegistry.find(modelName.slice(0, separator), modelName.slice(separator + 1));
  if (!model) fail(msg("unknown-model", { model: modelName }));

  const resourceLoader = new DefaultResourceLoader({
    cwd: session.worktree,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [
      join(packageExtensions, "sandbox", "index.ts"),
      join(packageExtensions, "consult.ts"),
      join(webAccessPackage, "index.ts"),
      join(browserPackage, "dist", "extensions", "agent-browser", "index.js"),
    ],
  });
  await resourceLoader.reload();

  const sessionManager = piSessionFiles(sessions, session.id).length === 0
    ? SessionManager.create(session.worktree, sessions, { id: session.id })
    : SessionManager.open(piSessionPath(sessions, session.id), sessions, session.worktree);
  const projectTools = command.sandbox === "read-only"
    ? ["read", "bash", "grep", "find", "ls"]
    : ["read", "bash", "write", "edit", "grep", "find", "ls"];
  const capabilityTools = ["consult_orchestrator", "web_search", "fetch_content", "get_search_content", "agent_browser"];
  const { session: agentSession, extensionsResult } = await createAgentSession({
    cwd: session.worktree,
    model,
    thinkingLevel: thinking as (typeof thinkingLevels)[number],
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: [...projectTools, ...capabilityTools],
  });
  const extensionError = extensionsResult.errors[0];
  if (extensionError) {
    agentSession.dispose();
    fail(msg("extension-load-failed", { path: extensionError.path, error: extensionError.error }));
  }
  await agentSession.bindExtensions({ mode: "print" });

  let abortRequested = false;
  let lastEventAt = Date.now();
  let result: string | undefined;
  let modelError: Error | undefined;
  const unsubscribe = agentSession.subscribe((event) => {
    lastEventAt = Date.now();
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      modelError = new Error(event.message.errorMessage || msg("pi-model-error-no-message"));
      return;
    }
    const text = assistantText(event.message);
    if (text) result = text;
  });

  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      void (async () => {
        try {
          const request = record(JSON.parse(input.slice(0, newline)), "Control request");
          if (request.type !== "steer" && request.type !== "follow_up" && request.type !== "abort") fail(msg("unknown-control-request", { type: String(request.type) }));
          if (request.type !== "abort" && typeof request.message !== "string") fail(msg("requires-a-message", { name: request.type }));
          if (request.type === "abort" && request.message !== undefined) fail(msg("abort-no-message"));
          if (request.type === "steer") await agentSession.steer(request.message as string);
          if (request.type === "follow_up") await agentSession.followUp(request.message as string);
          if (request.type === "abort") {
            abortRequested = true;
            await agentSession.abort();
          }
          socket.end(`${JSON.stringify({ success: true })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(control, resolveListen);
  });

  const question = join(sessions, `${session.id}.question.md`);
  const stallMs = 5 * 60 * 1000;
  let questionAnnounced = false;
  let warnedIntervals = 0;
  const monitor = setInterval(() => {
    if (existsSync(question)) {
      warnedIntervals = 0;
      if (questionAnnounced) return;
      let text: string;
      try {
        text = readFileSync(question, "utf8").trim();
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      process.stdout.write(`${msg("question-from-session", {
        id: session.id,
        text,
        path: join(sessions, `${session.id}.answer.md`),
      })}\n`);
      questionAnnounced = true;
      return;
    }
    questionAnnounced = false;
    const intervals = Math.floor(Math.max(0, Date.now() - lastEventAt) / stallMs);
    if (intervals > warnedIntervals) {
      process.stdout.write(`${msg("session-stalled", { id: session.id, minutes: String(intervals * 5) })}\n`);
    }
    warnedIntervals = intervals;
  }, 500);

  try {
    await agentSession.prompt(prompt, { source: "rpc" });
    await agentSession.waitForIdle();
    if (agentSession.pendingMessageCount !== 0) fail(msg("pi-settled-with-pending-messages"));
    if (modelError) throw modelError;

    const checkHandback = session.kind === "worktree" && command.sandbox === "worktree-write" && !rebaseInProgress(session.worktree);
    if (result && !abortRequested && checkHandback) {
      const blocker = handbackBlocker(session.worktree);
      if (blocker) {
        await agentSession.prompt(blocker, { source: "rpc" });
        await agentSession.waitForIdle();
        if (agentSession.pendingMessageCount !== 0) fail(msg("pi-settled-with-pending-messages"));
        if (modelError) throw modelError;
      }
    }
    if (result) return result;
    if (abortRequested) return msg("interrupted");
    return fail(msg("pi-settled-without-result"));
  } finally {
    clearInterval(monitor);
    unsubscribe();
    agentSession.dispose();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (existsSync(control)) rmSync(control);
  }
}

function composePrompt(command: PromptCommand, worktree: string, args: string[], flags: Flags): string {
  const injections: Record<string, string> = {};
  injections.base = flags.base;
  for (const [name, script] of Object.entries(command.inject)) injections[name] = shell(script, worktree);
  if (command.lifecycle === "create" || command.lifecycle === "in-place") {
    const plan = args[0];
    if (!plan) fail(msg("plan-file-required"));
    const planPath = resolve(plan);
    injections.plan_path = planPath;
    injections.plan = readFileSync(planPath, "utf8");
  }
  const readFiles = (paths: string[]) => paths.map((path) => readFileSync(resolve(path), "utf8")).join("\n\n");
  const guidance = command.lifecycle === "direct" ? "" : command.consult;
  const templateArgs = command.lifecycle === "create" || command.lifecycle === "in-place" ? args.slice(1) : args;
  const prompt = [readFiles(flags.prepend), guidance, renderTemplate(command.body, templateArgs, injections), readFiles(flags.append)]
    .filter(Boolean)
    .join("\n\n");
  const input: string[] = [];
  for (const entry of command.input) {
    switch (entry.kind) {
      case "prompt":
        input.push(prompt);
        break;
      case "text":
        input.push(entry.text.trimEnd());
        break;
      case "shell":
        input.push(bestEffortInputShell(entry.shell, worktree));
        break;
      default: {
        const unknownEntry: never = entry;
        fail(msg("unknown-input-entry", { entry: String(unknownEntry) }));
      }
    }
  }
  return input.filter(Boolean).join("\n\n");
}

async function runPrompt(name: string, project: string, values: string[]): Promise<void> {
  const command = parsePrompt(readFileSync(commandFile(name), "utf8"));
  const flags = parseFlags(values);
  const models = JSON.parse(readFileSync(join(home, "models.json"), "utf8")) as unknown;
  const promptThinking = command.thinking.kind === "prompt" ? command.thinking.level : undefined;
  const registry = ModelRegistry.create(AuthStorage.create());
  const registeredModels = registry.getAll().map(({ provider, id }) => `${provider}/${id}`);
  const resolvedModel = resolveModel(flags.model ?? command.model, flags.thinking ?? promptThinking, models, registeredModels);
  for (const path of [...flags.prepend, ...flags.append]) {
    if (!existsSync(resolve(path))) fail(msg("attachment-missing", { path: resolve(path) }));
  }
  const dirs = sessionDirs(project);
  if (command.lifecycle === "create" && !isGitRepository(dirs.main)) fail(msg("implement-in-worktree-requires-git"));
  let session: Session;
  let promptArgs = flags.args;

  if (command.lifecycle === "reuse") {
    const id = flags.args[0];
    if (!id) fail(msg("requires-session-id", { name }));
    session = readSession(dirs.sessions, id);
    if (session.kind === "review") fail(msg("cannot-resume-review-session", { id }));
    promptArgs = flags.args.slice(1);
    if (!existsSync(session.worktree)) fail(msg("session-worktree-missing", { worktree: session.worktree }));
    // Without its conversation JSONL, pi would silently start an amnesiac
    // session under the same id instead of resuming.
    const conversations = piSessionFiles(dirs.sessions, id);
    if (conversations.length !== 1) fail(msg("expected-one-jsonl", { id, count: String(conversations.length) }));
  } else if (command.lifecycle === "create" || command.lifecycle === "in-place") {
    const plan = flags.args[0];
    if (!plan) fail(msg("requires-plan-file", { name }));
    if (!existsSync(resolve(plan))) fail(msg("plan-file-missing", { path: resolve(plan) }));
    const id = sessionIdFromPlan(plan);
    if (findSessionPath(dirs.sessions, id)) fail(msg("session-already-exists", { id }));
    // A merged or discarded session leaves its conversation JSONL behind, which
    // permanently reserves the name; only "resume it" would be a lie here.
    if (piSessionFiles(dirs.sessions, id).length > 0) fail(msg("session-name-burned", { id }));
    if (command.lifecycle === "in-place") {
      session = {
        kind: "in-place",
        id,
        command: name,
        mainCheckout: dirs.main,
        worktree: dirs.main,
        createdAt: new Date().toISOString(),
      };
    } else {
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
    }
    writeSession(dirs.sessions, session);
  } else {
    let worktree = project;
    if (flags.args[0] && findSessionPath(dirs.sessions, flags.args[0])) {
      const target = readSession(dirs.sessions, flags.args[0]);
      worktree = target.worktree;
      promptArgs = flags.args.slice(1);
    }
    const id = `${name}-${Date.now()}`;
    session = {
      kind: "review",
      id,
      command: name,
      mainCheckout: dirs.main,
      worktree,
      createdAt: new Date().toISOString(),
    };
    writeSession(dirs.sessions, session);
  }

  const prompt = composePrompt(command, session.worktree, promptArgs, flags);
  const result = await sdkRun(session, dirs.sessions, command, prompt, resolvedModel.model, resolvedModel.thinking);
  for (const entry of command.output) {
    switch (entry.kind) {
      case "pi":
        process.stdout.write(`${result}\n`);
        break;
      case "text":
        process.stdout.write(entry.text);
        break;
      case "shell":
        process.stdout.write(`${tracedShell(entry.shell, session.worktree)}\n`);
        break;
      default: {
        const unknownEntry: never = entry;
        fail(msg("unknown-output-entry", { entry: String(unknownEntry) }));
      }
    }
  }
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
    .filter((file) => file.endsWith(".pi-for-claude.json"))
    .map((file) => readSessionFile(join(sessions, file)));
  const duplicate = records.find((record) => records.filter((candidate) => candidate.id === record.id).length > 1);
  if (duplicate) {
    const count = records.filter((record) => record.id === duplicate.id).length;
    fail(msg("duplicate-session-metadata", { id: duplicate.id, count: String(count) }));
  }
  for (const record of records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    process.stdout.write(`${record.id}\t${record.command}\t${record.worktree}\n`);
  }
}

function exportSession(source: string, output: string): void {
  const exported = spawnSync(piBin, ["--export", source, output], { encoding: "utf8" });
  if (exported.error) fail(msg("could-not-run", { command: piBin, error: exported.error.message }));
  if (exported.status !== 0) fail(exported.stderr.trim() || msg("command-failed", { command: `${piBin} --export` }));
  process.stdout.write(exported.stdout);
}

function liveSessionHtml(output: string): string {
  const html = readFileSync(output, "utf8");
  if (!html.includes("</body>")) fail(msg("view-html-missing-body", { output }));
  return html.replace("</body>", '<script>new EventSource("/events").onmessage=()=>location.reload()</script></body>');
}

async function view(project: string, values: string[]): Promise<void> {
  const id = values[0];
  const flag = values[1];
  if (!id || values.length > 2 || (flag !== undefined && flag !== "--no-open" && flag !== "--live")) fail(msg("view-usage"));
  const source = piSessionPath(sessionDirs(project).sessions, id);
  const output = `${source.slice(0, -".jsonl".length)}.html`;
  exportSession(source, output);
  if (flag === "--no-open") return;
  if (flag !== "--live") {
    const opened = spawnSync("open", [output], { encoding: "utf8" });
    if (opened.error) fail(msg("could-not-run", { command: "open", error: opened.error.message }));
    if (opened.status !== 0) fail(opened.stderr.trim() || msg("command-failed", { command: "open" }));
    return;
  }

  let html = liveSessionHtml(output);
  const clients = new Set<ServerResponse>();
  const server = createHttpServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.once("close", () => clients.delete(response));
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    fail(msg("view-server-address"));
  }
  const url = `http://127.0.0.1:${address.port}/`;

  const opened = spawnSync("open", [url], { encoding: "utf8" });
  if (opened.error || opened.status !== 0) {
    server.close();
    if (opened.error) fail(msg("could-not-run", { command: "open", error: opened.error.message }));
    fail(opened.stderr.trim() || msg("command-failed", { command: "open" }));
  }
  process.stdout.write(`${msg("view-watching", { source })}\n`);

  await new Promise<void>((_resolveWatch, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(source);
    const stop = (error: unknown) => {
      watcher.close();
      server.closeAllConnections();
      server.close();
      reject(error);
    };
    watcher.on("change", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          exportSession(source, output);
          html = liveSessionHtml(output);
          for (const client of clients) client.write("data: reload\n\n");
        } catch (error) {
          stop(error);
        }
      }, 100);
    });
    watcher.once("error", stop);
    server.once("error", stop);
  });
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
  for (const file of commandFiles().sort()) {
    const command = parsePrompt(readFileSync(join(home, "prompts", file), "utf8"));
    process.stdout.write(`  ${basename(file, ".md")} ${command.argumentHint}\t${command.description}\n`);
  }
  process.stdout.write(msg("help-builtins"));
}

async function main(argv: string[]): Promise<void> {
  refreshInstructions(home, process.cwd());
  const [name, ...values] = argv;
  if (!name || name === "help") return help();
  const project = process.cwd();
  if (name === "sessions") return listSessions(project);
  if (name === "view") return view(project, values);
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
