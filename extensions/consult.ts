import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderString } from "../src/core.ts";

const timeoutMs = 10 * 60 * 1000;
const stringsPath = join(import.meta.dirname, "..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(stringsPath, name, injections);
}

export default function consultExtension(pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "consult_orchestrator",
      label: "Consult orchestrator",
      description: "Ask the orchestrator a blocking implementation question and wait for its answer.",
      parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
      async execute(_id, { question }, signal) {
        const sessionDir = process.env.PI_RUN_SESSION_DIR;
        const sessionId = process.env.PI_RUN_SESSION_ID;
        if (!sessionDir || !sessionId) throw new Error(msg("consult-requires-env"));
        const questionPath = join(sessionDir, `${sessionId}.question.md`);
        const answerPath = join(sessionDir, `${sessionId}.answer.md`);
        if (existsSync(questionPath) || existsSync(answerPath)) throw new Error(msg("consult-already-pending", { id: sessionId }));
        writeFileSync(questionPath, `${question.trim()}\n`, { mode: 0o600 });
        const deadline = Date.now() + timeoutMs;

        while (!existsSync(answerPath) && Date.now() < deadline && !signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (signal?.aborted) {
          rmSync(questionPath, { force: true });
          throw new Error(msg("consult-aborted"));
        }
        if (!existsSync(answerPath)) {
          rmSync(questionPath, { force: true });
          return { content: [{ type: "text", text: msg("consult-timeout") }], details: {} };
        }
        const answer = readFileSync(answerPath, "utf8").trim();
        rmSync(questionPath);
        rmSync(answerPath);
        return { content: [{ type: "text", text: answer }], details: {} };
      },
    }),
  );
}
