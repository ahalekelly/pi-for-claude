import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

export function agentPaths(): AgentPaths {
  const agentDir = getAgentDir();
  const realAgentDir = resolveExistingAncestors(agentDir);
  return {
    agentDir,
    realAgentDir,
    auth: join(agentDir, "auth.json"),
    realAuth: join(realAgentDir, "auth.json"),
    lock: join(realAgentDir, "auth.json.lock"),
  };
}
