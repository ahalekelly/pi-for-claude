import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  createBashTool,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { agentPaths } from "../../agent-paths.ts";
import { renderString } from "../../core.ts";
import { usesRm } from "./command-guard.ts";
import { readBlocked, writeBlocked, type FilesystemPolicy } from "./path-guard.ts";

type Policy = SandboxRuntimeConfig & { filesystem: Omit<FilesystemPolicy, "gitWrite"> };

const policy = {
  network: {
    allowedDomains: [
      "api.github.com",
      "github.com",
      "*.github.com",
      "npmjs.org",
      "*.npmjs.org",
      "pypi.org",
      "*.pypi.org",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: [
      "~/.agents/secrets.env",
      "~/.secrets.env",
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      "~/.config/gcloud",
    ],
    allowWrite: [".", "/tmp/claude", "~/.Trash", "~/.local/share/Trash"],
    denyWrite: [
      ".git",
      "config.worktree",
      "commondir",
      "gitdir",
      "~/.npm/_logs/**",
      "~/.claude/debug/**",
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
    ],
  },
} satisfies Policy;

const stringsPath = join(import.meta.dirname, "../../..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(stringsPath, name, injections);
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
  const base: NodeJS.ProcessEnv = process.platform === "darwin"
    ? { ...process.env, PATH: process.env.PI_FOR_CLAUDE_SYSTEM_PATH }
    : { ...process.env };
  // Commit signing cannot work in the sandbox — the user's signing key is
  // unreadable by design, and pi signing as the user would be dishonest
  // anyway. Without this, a global commit.gpgsign=true fails every commit
  // with "could not create temporary file: Operation not permitted".
  //
  // NODE_USE_ENV_PROXY: the sandbox provides network only through the proxy
  // in HTTP(S)_PROXY, which Node's fetch ignores unless this is set — without
  // it, node scripts inside the sandbox cannot reach the network while curl
  // works.
  const environment: NodeJS.ProcessEnv = {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    NODE_USE_ENV_PROXY: "1",
  };
  if (!environment.PATH) throw new Error(msg("path-required"));

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (usesRm(command)) throw new Error(msg("rm-blocked"));
      if (!existsSync(cwd)) throw new Error(msg("cwd-does-not-exist", { cwd }));
      const timeoutSeconds = timeout && timeout > 0 ? Math.min(timeout, 600) : 600;
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrapped], {
          cwd,
          detached: true,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        }, timeoutSeconds * 1000);
        const abort = () => child.pid && process.kill(-child.pid, "SIGKILL");
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(new Error(msg("sandboxed-command-aborted")));
          else if (timedOut) reject(new Error(msg("sandboxed-command-timeout", { seconds: String(timeoutSeconds) })));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

export default function sandboxExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const localBash = createBashTool(cwd);
  const mode = process.env.PI_FOR_CLAUDE_SANDBOX_MODE;
  if (mode !== "worktree-write" && mode !== "project-write" && mode !== "read-only") throw new Error(msg("sandbox-mode-invalid"));
  const readOnly = mode === "read-only";
  const runtimePolicy: Policy = {
    network: policy.network,
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowWrite: readOnly
        ? ["/tmp/claude", "~/.Trash", "~/.local/share/Trash"]
        : [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
    },
  };
  const gitPaths = mode === "worktree-write" ? gitPolicyPaths(cwd) : { allow: [], deny: [] };
  const auth = agentPaths().realAuth;
  // The sandbox runtime points the child's TMPDIR at this directory (same
  // precedence) but neither creates it nor permits writes to it — Claude Code
  // sets CLAUDE_CODE_TMPDIR to its own per-user temp dir, so without these
  // two steps every TMPDIR-respecting tool (python tempfile, node os.tmpdir)
  // fails, and mktemp silently returns "" so `cat $tmp` hangs on stdin.
  const tmpdir = process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";
  runtimePolicy.filesystem.denyRead.push(auth);
  runtimePolicy.filesystem.allowWrite.push(tmpdir, ...gitPaths.allow);
  runtimePolicy.filesystem.denyWrite.push(auth, ...gitPaths.deny);
  const guardPolicy: FilesystemPolicy = { ...runtimePolicy.filesystem, gitWrite: gitPaths.allow };
  let state: "starting" | "ready" | "failed" = "starting";

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    description: `${localBash.description} The rm command is blocked because permanent deletion is not recoverable; use trash instead.`,
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
      mkdirSync(tmpdir, { recursive: true });
      await SandboxManager.initialize(runtimePolicy);
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
