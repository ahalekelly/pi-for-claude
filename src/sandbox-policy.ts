import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { FilesystemPolicy } from "./extensions/sandbox/path-guard.ts";

export type Policy = SandboxRuntimeConfig & { filesystem: Omit<FilesystemPolicy, "gitWrite"> };

export const sandboxGitExcludes = [
  ".bash_profile",
  ".bashrc",
  ".env",
  ".env.*",
  ".gitconfig",
  ".gitmodules",
  ".idea",
  ".mcp.json",
  ".profile",
  ".ripgreprc",
  ".vscode",
  ".zprofile",
  ".zshrc",
  "*.key",
  "*.pem",
];

const policy = {
  // The runtime restricts network only when allowedDomains is set; an empty
  // object leaves command network unrestricted while keeping the filesystem
  // sandbox. Its type marks allowedDomains required, hence the cast.
  network: {} as SandboxRuntimeConfig["network"],
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
export function basePolicy(readOnly: boolean, privateGit: boolean = false): Policy {
  return {
    network: policy.network,
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowWrite: readOnly ? ["/tmp/claude", "~/.Trash", "~/.local/share/Trash"] : [...policy.filesystem.allowWrite],
      denyWrite: policy.filesystem.denyWrite.filter((entry) => !privateGit || entry !== ".git"),
    },
  };
}
