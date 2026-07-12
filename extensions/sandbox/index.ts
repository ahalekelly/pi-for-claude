import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createBashTool,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager, type SandboxRuntimeConfig } from "@sysid/sandbox-runtime-improved";

import { readBlocked, writeBlocked, type FilesystemPolicy } from "./path-guard.ts";

type Policy = SandboxRuntimeConfig & { filesystem: FilesystemPolicy };

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Sandbox field '${field}' must be an array of non-empty strings`);
  }
  return value;
}

function loadPolicy(readOnly: boolean): Policy {
  const path = join(import.meta.dirname, "sandbox.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed sandbox policy: ${path}`);
  const source = value as Record<string, unknown>;
  if (!Object.keys(source).every((key) => key === "network" || key === "filesystem")) throw new Error(`Unknown sandbox policy field: ${path}`);
  if (!source.network || typeof source.network !== "object" || Array.isArray(source.network)) throw new Error(`Malformed sandbox network policy: ${path}`);
  if (!source.filesystem || typeof source.filesystem !== "object" || Array.isArray(source.filesystem)) throw new Error(`Malformed sandbox filesystem policy: ${path}`);
  const network = source.network as Record<string, unknown>;
  const filesystem = source.filesystem as Record<string, unknown>;
  if (!Object.keys(network).every((key) => key === "allowedDomains" || key === "deniedDomains")) throw new Error(`Unknown sandbox network field: ${path}`);
  if (!Object.keys(filesystem).every((key) => key === "denyRead" || key === "allowWrite" || key === "denyWrite")) {
    throw new Error(`Unknown sandbox filesystem field: ${path}`);
  }
  return {
    network: {
      allowedDomains: stringArray(network.allowedDomains, "network.allowedDomains"),
      deniedDomains: stringArray(network.deniedDomains, "network.deniedDomains"),
    },
    filesystem: {
      denyRead: stringArray(filesystem.denyRead, "filesystem.denyRead"),
      allowWrite: readOnly ? ["/tmp/claude"] : stringArray(filesystem.allowWrite, "filesystem.allowWrite"),
      denyWrite: stringArray(filesystem.denyWrite, "filesystem.denyWrite"),
    },
  };
}

function sandboxedBash(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrapped], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            }, timeout * 1000)
          : undefined;
        const abort = () => child.pid && process.kill(-child.pid, "SIGKILL");
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("error", reject);
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(new Error("Sandboxed command aborted"));
          else if (timedOut) reject(new Error(`Sandboxed command timed out after ${timeout} seconds`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

export default function sandboxExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const localBash = createBashTool(cwd);
  const mode = process.env.PI_RUN_SANDBOX_MODE;
  if (mode !== "worktree-write" && mode !== "read-only") throw new Error("PI_RUN_SANDBOX_MODE must be worktree-write or read-only");
  const readOnly = mode === "read-only";
  const policy = loadPolicy(readOnly);
  let state: "starting" | "ready" | "failed" = "starting";

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate) {
      if (state === "failed") throw new Error("Sandbox initialization failed; bash is blocked");
      if (state === "starting") throw new Error("Sandbox has not initialized; bash is blocked");
      return createBashTool(cwd, { operations: sandboxedBash() }).execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (state !== "ready") throw new Error("Sandbox is unavailable; bash is blocked");
    return { operations: sandboxedBash() };
  });

  pi.on("tool_call", (event, ctx) => {
    for (const tool of ["read", "grep", "find", "ls"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = readBlocked(String(event.input.path), policy.filesystem, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    }
    for (const tool of ["write", "edit"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = writeBlocked(String(event.input.path), policy.filesystem, ctx.cwd, readOnly);
      return reason ? { block: true, reason } : undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await SandboxManager.initialize(policy);
      state = "ready";
      ctx.ui.notify(`Sandbox initialized in ${mode} mode`, "info");
    } catch (error) {
      state = "failed";
      ctx.ui.notify(`Sandbox initialization failed; bash is blocked: ${error instanceof Error ? error.message : error}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    if (state === "ready") await SandboxManager.reset();
  });
}
