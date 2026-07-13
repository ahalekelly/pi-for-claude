import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentPaths = {
  agentDir: string;
  realAgentDir: string;
  auth: string;
  realAuth: string;
  lock: string;
};

function resolveExistingAncestors(path: string): string {
  const missing: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return join(homedir(), configured.slice(2));
  }
  if (/^file:\/\//.test(configured)) return fileURLToPath(configured);
  return configured;
}

export function agentPaths(): AgentPaths {
  const configuredAgentDir = agentDir();
  const realAgentDir = resolveExistingAncestors(configuredAgentDir);
  return {
    agentDir: configuredAgentDir,
    realAgentDir,
    auth: join(configuredAgentDir, "auth.json"),
    realAuth: join(realAgentDir, "auth.json"),
    lock: join(realAgentDir, "auth.json.lock"),
  };
}
