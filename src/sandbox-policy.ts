import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { FilesystemPolicy } from "./extensions/sandbox/path-guard.ts";

export type Policy = SandboxRuntimeConfig & { filesystem: Omit<FilesystemPolicy, "gitWrite"> };

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

// The sandbox runtime points the child's TMPDIR at this directory (same
// precedence) but neither creates it nor permits writes to it.
export function sandboxTmpdir(): string {
  return process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";
}

// A fresh copy per session: the extension appends session-specific paths.
export function basePolicy(readOnly: boolean): Policy {
  return {
    network: policy.network,
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowWrite: readOnly ? ["/tmp/claude", "~/.Trash", "~/.local/share/Trash"] : [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
    },
  };
}
