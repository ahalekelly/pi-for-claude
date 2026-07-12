import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  createBashTool,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager, type SandboxRuntimeConfig } from "@sysid/sandbox-runtime-improved";

import { renderString } from "../../src/core.ts";
import { readBlocked, writeBlocked, type FilesystemPolicy } from "./path-guard.ts";

type Policy = SandboxRuntimeConfig & { filesystem: Omit<FilesystemPolicy, "gitWrite"> };

const stringsPath = join(import.meta.dirname, "../..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(stringsPath, name, injections);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(msg("sandbox-field-not-string-array", { field }));
  }
  return value;
}

function loadPolicy(readOnly: boolean): Policy {
  const path = join(import.meta.dirname, "sandbox.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(msg("malformed-sandbox-policy", { path }));
  const source = value as Record<string, unknown>;
  if (!Object.keys(source).every((key) => key === "network" || key === "filesystem")) throw new Error(msg("unknown-sandbox-policy-field", { path }));
  if (!source.network || typeof source.network !== "object" || Array.isArray(source.network)) throw new Error(msg("malformed-sandbox-network-policy", { path }));
  if (!source.filesystem || typeof source.filesystem !== "object" || Array.isArray(source.filesystem)) throw new Error(msg("malformed-sandbox-filesystem-policy", { path }));
  const network = source.network as Record<string, unknown>;
  const filesystem = source.filesystem as Record<string, unknown>;
  if (!Object.keys(network).every((key) => key === "allowedDomains" || key === "deniedDomains")) throw new Error(msg("unknown-sandbox-network-field", { path }));
  if (!Object.keys(filesystem).every((key) => key === "denyRead" || key === "allowWrite" || key === "denyWrite")) {
    throw new Error(msg("unknown-sandbox-filesystem-field", { path }));
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

// Git state pi may write, all scoped to its own session: the linked worktree's
// git dir (index, HEAD, rebase state), the shared object store, the session
// branch ref and reflog, and info/exclude. Hooks, config, and other branches
// are never included, and the worktree-pointer files inside the git dir are
// explicitly denied because tampering with them would redirect git commands the
// orchestrator later runs outside the sandbox. A main checkout (git dir ==
// common dir) gets nothing.
function gitPolicyPaths(cwd: string): { allow: string[]; deny: string[] } {
  const out = (args: string[]): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr.trim() || msg("git-command-failed", { args: args.join(" ") }));
    return result.stdout.trim();
  };
  const gitDir = out(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = out(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDir === commonDir) return { allow: [], deny: [] };
  // The session branch is pi/<worktree name> by construction. Derived from the
  // path, not `git branch --show-current`, because a session resumed mid-rebase
  // has a detached HEAD.
  const branch = `pi/${basename(cwd)}`;
  return {
    allow: [
      gitDir,
      join(commonDir, "objects"),
      join(commonDir, "refs", "heads", branch),
      join(commonDir, "refs", "heads", `${branch}.lock`),
      join(commonDir, "logs", "refs", "heads", branch),
      join(commonDir, "logs", "refs", "heads", `${branch}.lock`),
      join(commonDir, "info", "exclude"),
    ],
    deny: ["config.worktree", "commondir", "gitdir"].map((name) => join(gitDir, name)),
  };
}

function sandboxedBash(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(msg("cwd-does-not-exist", { cwd }));
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
          if (signal?.aborted) reject(new Error(msg("sandboxed-command-aborted")));
          else if (timedOut) reject(new Error(msg("sandboxed-command-timeout", { seconds: String(timeout) })));
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
  if (mode !== "worktree-write" && mode !== "project-write" && mode !== "read-only") throw new Error(msg("sandbox-mode-invalid"));
  const readOnly = mode === "read-only";
  const policy = loadPolicy(readOnly);
  const gitPaths = mode === "worktree-write" ? gitPolicyPaths(cwd) : { allow: [], deny: [] };
  policy.filesystem.allowWrite.push(...gitPaths.allow);
  policy.filesystem.denyWrite.push(...gitPaths.deny);
  const guardPolicy: FilesystemPolicy = { ...policy.filesystem, gitWrite: gitPaths.allow };
  let state: "starting" | "ready" | "failed" = "starting";

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate) {
      if (state === "failed") throw new Error(msg("sandbox-init-failed-blocked"));
      if (state === "starting") throw new Error(msg("sandbox-not-initialized-blocked"));
      return createBashTool(cwd, { operations: sandboxedBash() }).execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (state !== "ready") throw new Error(msg("sandbox-unavailable-blocked"));
    return { operations: sandboxedBash() };
  });

  pi.on("tool_call", (event, ctx) => {
    for (const tool of ["read", "grep", "find", "ls"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = readBlocked(String(event.input.path), guardPolicy, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    }
    for (const tool of ["write", "edit"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = writeBlocked(String(event.input.path), guardPolicy, ctx.cwd, readOnly);
      return reason ? { block: true, reason } : undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await SandboxManager.initialize(policy);
      state = "ready";
      ctx.ui.notify(msg("sandbox-initialized", { mode }), "info");
    } catch (error) {
      state = "failed";
      ctx.ui.notify(msg("sandbox-init-failed-notify", { error: error instanceof Error ? error.message : String(error) }), "error");
    }
  });

  pi.on("session_shutdown", async () => {
    if (state === "ready") await SandboxManager.reset();
  });
}
