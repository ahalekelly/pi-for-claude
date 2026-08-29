#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createConnection, createServer } from "node:net";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { agentDir, agentPaths } from "./agent-paths.ts";
import { parsePrompt, renderString, renderTemplate, resolveModel, thinkingLevels, type PromptCommand } from "./core.ts";
import { locklessSettings, refreshInstructions } from "./instructions.ts";
import { git, resolveProject, sessionIdFromPlan } from "./runner.ts";
import { basePolicy, sandboxGitExcludes } from "./sandbox-policy.ts";
import { type NewSession, type Session, SessionStore, type TurnWriter } from "./session-store.ts";
import { setup } from "./setup.ts";
import { packageVersion, showVersion, update } from "./update.ts";

const controlFileSchema = Type.Object({
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  token: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, { additionalProperties: false });
type ControlFile = Static<typeof controlFileSchema>;

type Flags = {
  args: string[];
  prepend: string[];
  append: string[];
  model: string | undefined;
  thinking: string | undefined;
  base: string;
  consult: boolean;
};

const home = resolve(process.env.PI_FOR_CLAUDE_HOME ?? dirname(import.meta.dirname));
const version = packageVersion(home);
const packageExtensions = join(import.meta.dirname, "extensions");

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

function fail(message: string): never {
  throw new Error(message);
}

function validate<Type extends TSchema>(schema: Type, value: unknown, message: string): Static<Type> {
  if (!Check(schema, value)) fail(message);
  return value;
}

// Model-facing text lives in prompts/strings.json, never inline in code.
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

// One process serves one turn. Output is mirrored into its invocation log so
// `watch` can follow a run this process's stdout does not reach.
let activeTurn: TurnWriter | undefined;
let resumableSessionId: string | undefined;
function emit(text: string): void {
  process.stdout.write(text);
  activeTurn?.append(text);
}

function sessionDirs(project: string) {
  const resolved = resolveProject(project);
  const root = resolved.kind === "checkout" ? resolved.main : resolved.dir;
  const sessions = join(root, ".agents", "sessions");
  const worktrees = join(root, ".agents", "worktrees");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(worktrees, { recursive: true });
  return { root, sessions, worktrees, kind: resolved.kind, store: new SessionStore(sessions, home, version) };
}

function parseFlags(values: string[]): Flags {
  const flags: Flags = { args: [], prepend: [], append: [], model: undefined, thinking: undefined, base: "HEAD", consult: true };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--no-consult") {
      flags.consult = false;
      continue;
    }
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

function trashPath(path: string): void {
  const command = process.platform === "win32" ? "trash.cmd" : "trash";
  const result = spawnSync(command, [path], { encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) fail(result.stderr.trim() || msg("command-failed", { command }));
}

function bestEffortInputShell(command: string, cwd: string): string {
  const result = spawnSync("sh", ["-c", `exec 2>&1\n${command}`], { cwd, encoding: "utf8" });
  if (result.error) fail(msg("could-not-run", { command, error: result.error.message }));
  const output = result.stdout.trimEnd();
  if (result.status === 0) return output;
  const status = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  const failure = msg("input-shell-failed", { command, status, output: output || msg("no-command-output") });
  emit(`${failure}\n`);
  return failure;
}

// Output shell blocks run traced (`+ command` lines interleaved with their
// output) so the orchestrator sees what produced each result. They are
// best-effort: a failing command's error text appears in the trace, but never
// fails the run they decorate. PI_FOR_CLAUDE_PROJECT names the checkout the run
// was launched from, which a session worktree cannot derive from git alone.
function tracedShell(command: string, cwd: string, project: string): string {
  const env = { ...process.env, PI_FOR_CLAUDE_PROJECT: project };
  const result = spawnSync("sh", ["-c", `exec 2>&1\nset -x\n${command}`], { cwd, env, encoding: "utf8" });
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

function readControlFile(path: string): ControlFile {
  return validate(controlFileSchema, JSON.parse(readFileSync(path, "utf8")), msg("malformed-control-file", { path }));
}

async function controlPortIsLive(path: string): Promise<boolean> {
  let location: ControlFile;
  try {
    location = readControlFile(path);
  } catch {
    return false;
  }
  return new Promise((resolveProbe) => {
    const probe = createConnection({ host: "127.0.0.1", port: location.port });
    probe.once("connect", () => { probe.destroy(); resolveProbe(true); });
    probe.once("error", () => { probe.destroy(); resolveProbe(false); });
  });
}

async function sdkRun(
  sdk: PiSdk,
  modelRuntime: ModelRuntime,
  session: Session | NewSession,
  sessions: string,
  store: SessionStore,
  command: PromptCommand,
  prompt: string,
  modelName: string,
  thinking: string,
  consult: boolean,
): Promise<{ result: string; streamed: boolean }> {
  const sessionDir = join(sessions, session.id);
  const control = join(sessionDir, "control.json");
  if (existsSync(control)) {
    if (await controlPortIsLive(control)) fail(msg("session-currently-running", { id: session.id }));
    rmSync(control);
  }

  const executablePath = process.env.PATH;
  if (!executablePath) fail(msg("path-required"));
  process.chdir(session.worktree);
  process.env.PI_FOR_CLAUDE_SANDBOX_MODE = command.sandbox;
  process.env.PI_FOR_CLAUDE_SESSION_DIR = sessionDir;
  process.env.PI_FOR_CLAUDE_SESSION_ID = session.id;
  process.env.PI_FOR_CLAUDE_SYSTEM_PATH = executablePath;
  const agentBrowserPackage = dirname(fileURLToPath(import.meta.resolve("agent-browser/package.json")));
  process.env.PATH = `${join(dirname(agentBrowserPackage), ".bin")}${delimiter}${executablePath}`;

  const configuredAgentDir = agentDir();
  const settingsManager = locklessSettings(sdk.SettingsManager, session.worktree, configuredAgentDir, true);
  const separator = modelName.indexOf("/");
  if (separator === -1) fail(msg("unknown-model", { model: modelName }));
  const model = modelRuntime.getModel(modelName.slice(0, separator), modelName.slice(separator + 1));
  if (!model) fail(msg("unknown-model", { model: modelName }));

  const webAccessPackage = dirname(fileURLToPath(import.meta.resolve("pi-web-access/package.json")));
  const browserPackage = dirname(fileURLToPath(import.meta.resolve("pi-agent-browser-native/package.json")));
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: session.worktree,
    agentDir: configuredAgentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [
      join(packageExtensions, "sandbox", "index.ts"),
      ...(consult ? [join(packageExtensions, "consult.ts")] : []),
      join(webAccessPackage, "index.ts"),
      join(browserPackage, "dist", "extensions", "agent-browser", "index.js"),
    ],
  });
  await resourceLoader.reload();

  const sessionManager = "conversation" in session
    ? sdk.SessionManager.open(session.conversation, sessionDir, session.worktree)
    : sdk.SessionManager.create(session.worktree, sessionDir, { id: session.id });
  if (!("conversation" in session)) {
    const conversation = sessionManager.getSessionFile();
    if (!conversation) fail(msg("conversation-path-required"));
    store.save(session, conversation);
  }
  const projectTools = command.sandbox === "read-only"
    ? ["read", "bash", "grep", "find", "ls"]
    : ["read", "bash", "write", "edit", "grep", "find", "ls"];
  const capabilityTools = [...(consult ? ["consult_orchestrator"] : []), "web_search", "fetch_content", "get_search_content", "agent_browser"];
  const { session: agentSession, extensionsResult } = await sdk.createAgentSession({
    cwd: session.worktree,
    model,
    thinkingLevel: thinking as (typeof thinkingLevels)[number],
    modelRuntime,
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
  let streamed = false;
  let modelError: Error | undefined;
  const unsubscribe = agentSession.subscribe((event) => {
    lastEventAt = Date.now();
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      activeTurn?.append(event.assistantMessageEvent.delta);
      streamed = true;
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      modelError = new Error(event.message.errorMessage ? msg("pi-model-error", { message: event.message.errorMessage }) : msg("pi-model-error-no-message"));
      return;
    }
    // Pi auto-retries transient stream errors (rate limits, dropped
    // WebSockets); a later successful assistant message means the run
    // recovered, so only an error still standing when the session settles
    // is fatal.
    modelError = undefined;
    const text = assistantText(event.message);
    if (text) result = text;
  });

  const token = randomBytes(32).toString("hex");
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
          if (request.token !== token) fail(msg("invalid-control-token"));
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
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail(msg("control-server-address"));
  writeFileSync(control, `${JSON.stringify({ port: address.port, token })}\n`, { mode: 0o600 });

  activeTurn?.running();
  const question = join(sessionDir, `${session.id}.question.md`);
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
      emit(`${msg("question-from-session", {
        id: session.id,
        text,
        path: join(sessionDir, `${session.id}.answer.md`),
      })}\n`);
      questionAnnounced = true;
      return;
    }
    questionAnnounced = false;
    const intervals = Math.floor(Math.max(0, Date.now() - lastEventAt) / stallMs);
    if (intervals > warnedIntervals) {
      emit(`${msg("session-stalled", { id: session.id, minutes: String(intervals * 5) })}\n`);
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
    if (result) return { result, streamed };
    if (abortRequested) return { result: msg("interrupted"), streamed };
    return fail(msg("pi-settled-without-result"));
  } finally {
    clearInterval(monitor);
    unsubscribe();
    // dispose() marks every extension ctx stale without telling extensions, so
    // a still-pending background task (e.g. a pi-web-access content fetch)
    // would later touch its stale ctx and crash the process after a successful
    // run. Emit session_shutdown first — the SDK's own AgentSessionRuntime
    // teardown does the same — so extensions abort their pending work.
    if (agentSession.extensionRunner.hasHandlers("session_shutdown")) {
      await agentSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
    agentSession.dispose();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (existsSync(control)) rmSync(control);
  }
}

function composePrompt(command: PromptCommand, worktree: string, project: string, args: string[], flags: Flags): string {
  const injections: Record<string, string> = {};
  injections.base = flags.base;
  injections.project = project;
  for (const [name, script] of Object.entries(command.inject)) injections[name] = shell(script, worktree);
  if (command.mode === "worktree" || command.mode === "in-place") {
    const planPath = resolve(args[0]!);
    injections.plan_path = planPath;
    injections.plan = readFileSync(planPath, "utf8");
  }
  const readFiles = (paths: string[]) => paths.map((path) => readFileSync(resolve(path), "utf8")).join("\n\n");
  const guidance = command.mode === "review" ? "" : flags.consult ? command.consult : msg("no-consult-guidance");
  const templateArgs = command.mode === "worktree" || command.mode === "in-place" ? args.slice(1) : args;
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

async function preflightControlBinding(): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
      fail(msg("control-bind-preflight-failed"));
    }
    throw error;
  } finally {
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function preflightAuthWrite(): void {
  const paths = agentPaths();
  try {
    mkdirSync(paths.lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")) {
      fail(msg("auth-write-preflight-failed", { auth: paths.realAuth, lock: paths.lock }));
    }
    throw error;
  }
  rmdirSync(paths.lock);
}

async function preflightSandbox(readOnly: boolean): Promise<void> {
  try {
    await SandboxManager.initialize(basePolicy(readOnly));
  } catch (error) {
    fail(msg("sandbox-preflight-failed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    await SandboxManager.reset();
  }
}

async function runPrompt(name: string, project: string, values: string[]): Promise<void> {
  const command = parsePrompt(readFileSync(commandFile(name), "utf8"));
  const flags = parseFlags(values);
  if (command.mode === "resume" && !flags.args[0]) fail(msg("requires-session-id", { name }));
  if ((command.mode === "worktree" || command.mode === "in-place") && !flags.args[0]) fail(msg("requires-plan-file", { name }));
  const dirs = sessionDirs(project);
  if (command.mode === "worktree" && dirs.kind !== "checkout") fail(msg("implement-in-worktree-requires-git"));

  let session: Session | NewSession;
  let promptArgs = flags.args;
  if (command.mode === "resume") {
    const id = flags.args[0]!;
    const existing = dirs.store.readActive(id);
    if (existing.kind === "review") fail(msg("cannot-resume-review-session", { id }));
    if (!existsSync(existing.worktree)) fail(msg("session-worktree-missing", { worktree: existing.worktree }));
    if (!existsSync(existing.conversation)) fail(msg("conversation-missing", { path: existing.conversation }));
    session = existing;
    promptArgs = flags.args.slice(1);
  } else if (command.mode === "worktree" || command.mode === "in-place") {
    const plan = flags.args[0]!;
    if (!existsSync(resolve(plan))) fail(msg("plan-file-missing", { path: resolve(plan) }));
    const id = sessionIdFromPlan(plan);
    if (dirs.store.exists(id)) {
      const existing = dirs.store.read(id);
      fail(msg(existing.status === "active" ? "session-already-exists" : "session-name-burned", { id }));
    }
    if (command.mode === "in-place") {
      session = {
        kind: "in-place",
        id,
        command: name,
        mainCheckout: dirs.root,
        worktree: dirs.root,
        createdAt: new Date().toISOString(),
      };
    } else {
      session = {
        kind: "worktree",
        id,
        command: name,
        mainCheckout: dirs.root,
        worktree: join(dirs.worktrees, id),
        branch: `pi/${id}`,
        baseCommit: git(dirs.root, ["rev-parse", "HEAD"]),
        mergeState: { kind: "unrebased" },
        createdAt: new Date().toISOString(),
      };
    }
  } else {
    let worktree = project;
    if (flags.args[0] && dirs.store.exists(flags.args[0])) {
      const target = dirs.store.readActive(flags.args[0]);
      worktree = target.worktree;
      promptArgs = flags.args.slice(1);
    }
    session = {
      kind: "review",
      id: `${name}-${Date.now()}`,
      command: name,
      mainCheckout: dirs.root,
      worktree,
      createdAt: new Date().toISOString(),
    };
  }

  activeTurn = dirs.store.beginTurn(session.id, randomBytes(16).toString("hex"));
  if (session.kind !== "review") resumableSessionId = session.id;
  await preflightControlBinding();
  preflightAuthWrite();
  await preflightSandbox(command.sandbox === "read-only");
  const sdk = await import("@earendil-works/pi-coding-agent");
  refreshInstructions(sdk.SettingsManager, home, project);
  const models = JSON.parse(readFileSync(join(home, "models.json"), "utf8")) as unknown;
  const promptThinking = command.thinking.kind === "prompt" ? command.thinking.level : undefined;
  const modelRuntime = await sdk.ModelRuntime.create();
  const registeredModels = modelRuntime.getModels().map(({ provider, id }) => `${provider}/${id}`);
  const resolvedModel = resolveModel(flags.model ?? command.model, flags.thinking ?? promptThinking, models, registeredModels);
  for (const path of [...flags.prepend, ...flags.append]) {
    if (!existsSync(resolve(path))) fail(msg("attachment-missing", { path: resolve(path) }));
  }
  if (!("conversation" in session) && session.kind === "worktree") {
    git(dirs.root, ["clone", "--local", "--no-checkout", "--no-tags", dirs.root, session.worktree]);
    git(session.worktree, ["checkout", "-b", session.branch, session.baseCommit]);
    appendFileSync(join(session.worktree, ".git", "info", "exclude"), `\n${sandboxGitExcludes.join("\n")}\n`);
  }
  const prompt = composePrompt(command, session.worktree, dirs.root, promptArgs, flags);
  const run = await sdkRun(sdk, modelRuntime, session, dirs.sessions, dirs.store, command, prompt, resolvedModel.model, resolvedModel.thinking, flags.consult);
  session = dirs.store.read(session.id);
  for (const entry of command.output) {
    switch (entry.kind) {
      case "pi":
        process.stdout.write(`${run.result}\n`);
        if (!run.streamed) activeTurn.append(`${run.result}\n`);
        break;
      case "text":
        emit(entry.text);
        break;
      case "shell":
        emit(`${tracedShell(entry.shell, session.worktree, dirs.root)}\n`);
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
      emit(`\n${msg("handback-rebase-warning", { worktree: session.worktree, conflicts })}\n`);
    } else {
      const blocker = handbackBlocker(session.worktree);
      if (blocker) emit(`\n${msg("handback-warning", { worktree: session.worktree, problem: blocker })}\n`);
    }
  }
  activeTurn.append(`${msg("session-settled")}\n`);
  activeTurn.settle(run.result);
}

function control(project: string, id: string, type: "steer" | "follow_up" | "abort", message: string): Promise<void> {
  const { sessions, store } = sessionDirs(project);
  store.readActive(id);
  const path = join(sessions, id, "control.json");
  if (!existsSync(path)) fail(msg("session-not-currently-running", { id }));
  const location = readControlFile(path);
  return new Promise((resolveControl, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: location.port });
    let input = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (data) => {
      input += data;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const response = record(JSON.parse(input.slice(0, newline)), "Control response");
      if (typeof response.success !== "boolean") fail(msg("success-must-be-boolean", { context: "Control response" }));
      if (!response.success) {
        if (typeof response.error !== "string") fail(msg("failed-response-no-error", { context: "control" }));
        reject(new Error(response.error));
      } else resolveControl();
      socket.destroy();
    });
    const request = message ? { type, message, token: location.token } : { type, token: location.token };
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

function listSessions(project: string): void {
  for (const record of sessionDirs(project).store.list()) {
    process.stdout.write(`${record.id}\t${record.command}\t${record.worktree}\n`);
  }
}

function exportSession(source: string, output: string): void {
  const piPackage = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piBin = process.env.PI_BIN ?? join(dirname(piPackage), "cli.js");
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
  const source = sessionDirs(project).store.read(id).conversation;
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
  const { root, store } = sessionDirs(project);
  const session = store.readActive(id);
  if (session.kind !== "worktree") fail(msg("session-no-mergeable-branch", { id }));
  if (rebaseInProgress(session.worktree)) fail(msg("session-rebase-in-progress", { id }));
  if (git(session.worktree, ["status", "--porcelain"])) {
    fail(msg("session-uncommitted-changes", { id, worktree: session.worktree }));
  }
  const rootBranch = git(root, ["branch", "--show-current"]);
  if (!rootBranch) fail(msg("project-not-on-branch"));
  const rootHead = git(root, ["rev-parse", "HEAD"]);
  if (session.mergeState.kind === "unrebased" || session.mergeState.onto !== rootHead) {
    git(session.worktree, ["fetch", "--no-tags", root, rootBranch]);
    const rebase = spawnSync("git", ["rebase", rootHead], { cwd: session.worktree, encoding: "utf8" });
    if (rebase.status !== 0) {
      const conflicts = git(session.worktree, ["diff", "--name-only", "--diff-filter=U"]);
      fail(msg("rebase-stopped-with-conflicts", { conflicts, worktree: session.worktree, id: session.id }));
    }
    if (rootHead !== session.baseCommit) {
      session.mergeState = { kind: "rebased", onto: rootHead };
      store.update(session);
      process.stdout.write(`${msg("rebased-onto-updated", { id, branch: rootBranch, worktree: session.worktree })}\n`);
      return;
    }
  }
  const rebasedOnto = session.mergeState.kind === "rebased" ? session.mergeState.onto : rootHead;
  if (git(root, ["rev-parse", "HEAD"]) !== rebasedOnto) fail(msg("project-moved-after-rebase"));
  if (git(session.worktree, ["rev-parse", "HEAD"]) === rebasedOnto) fail(msg("session-no-changes-to-merge", { id }));
  git(root, ["fetch", "--no-tags", session.worktree, session.branch]);
  const candidate = git(root, ["rev-parse", "FETCH_HEAD"]);
  if (candidate !== git(session.worktree, ["rev-parse", "HEAD"])) fail(msg("imported-commit-mismatch"));
  git(root, ["merge", "--ff-only", candidate]);
  store.close(session);
  trashPath(session.worktree);
  process.stdout.write(`${msg("merged", { id, branch: rootBranch })}\n`);
}

function discard(project: string, id: string): void {
  const { store } = sessionDirs(project);
  const session = store.readActive(id);
  if (session.kind === "worktree" && existsSync(session.worktree)) trashPath(session.worktree);
  store.close(session);
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

async function watchSession(project: string, values: string[]): Promise<void> {
  const id = values[0];
  if (!id || values.length > 1) fail(msg("watch-usage"));
  const store = sessionDirs(project).store;
  const initial = store.readTurn(id);
  let offset = 0;
  for (;;) {
    const turn = store.readTurn(id);
    if (turn.id !== initial.id) fail(msg("session-turn-changed", { id }));
    if (existsSync(turn.log)) {
      const content = readFileSync(turn.log, "utf8");
      if (content.length > offset) {
        process.stdout.write(content.slice(offset));
        offset = content.length;
      }
    }
    if (turn.state === "settled") return;
    if (turn.state === "failed") {
      process.exitCode = 1;
      return;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
}

async function main(argv: string[]): Promise<void> {
  const [name, ...values] = argv;
  if (name === "setup") return setup(home);
  if (name === "update") {
    if (values.length > 0) fail(msg("update-usage"));
    return update(home, process.cwd());
  }
  if (name === "version") {
    if (values.length > 0) fail(msg("version-usage"));
    return showVersion(home, fileURLToPath(import.meta.url));
  }
  if (!name || name === "help") return help();
  const project = process.cwd();
  if (name === "sessions") return listSessions(project);
  if (name === "watch") return watchSession(project, values);
  if (name === "view") return view(project, values);
  if (name === "result") {
    const id = values[0];
    if (!id) fail(msg("requires-session-id", { name }));
    const store = sessionDirs(project).store;
    store.read(id);
    const turn = store.readTurn(id);
    if (turn.state === "starting" || turn.state === "running") fail(msg("session-currently-running", { id }));
    if (turn.state === "failed") fail(turn.error);
    process.stdout.write(`${turn.result}\n`);
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
  let report = `${msg("error-prefix", { message: error instanceof Error ? error.message : String(error) })}\n`;
  if (resumableSessionId) report += `${msg("session-resume-hint", { id: resumableSessionId })}\n`;
  process.stderr.write(report);
  // Filesystem permission errors reaching here are almost always an
  // operating-system sandbox denying a session-state write (seatbelt matches
  // real paths, so symlinked writable roots don't count); say what to do.
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "EPERM" || code === "EACCES") process.stderr.write(`${msg("fs-permission-denied-hint")}\n`);
  if (activeTurn) {
    activeTurn.append(`${report}${msg("session-failed")}\n`);
    activeTurn.fail(report.trim());
  }
  process.exitCode = 1;
});
