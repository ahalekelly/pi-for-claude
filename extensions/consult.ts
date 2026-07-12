import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const timeoutMs = 10 * 60 * 1000;

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
        if (!sessionDir || !sessionId) throw new Error("Consult requires PI_RUN_SESSION_DIR and PI_RUN_SESSION_ID");
        const questionPath = join(sessionDir, `${sessionId}.question.md`);
        const answerPath = join(sessionDir, `${sessionId}.answer.md`);
        if (existsSync(questionPath) || existsSync(answerPath)) throw new Error(`A consult is already pending for '${sessionId}'`);
        writeFileSync(questionPath, `${question.trim()}\n`, { mode: 0o600 });
        const deadline = Date.now() + timeoutMs;

        while (!existsSync(answerPath) && Date.now() < deadline && !signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (signal?.aborted) {
          rmSync(questionPath, { force: true });
          throw new Error("Consult aborted");
        }
        if (!existsSync(answerPath)) {
          rmSync(questionPath, { force: true });
          const timeoutMessage = readFileSync(join(import.meta.dirname, "..", "prompts", "messages", "consult-timeout.md"), "utf8").trim();
          return { content: [{ type: "text", text: timeoutMessage }], details: {} };
        }
        const answer = readFileSync(answerPath, "utf8").trim();
        rmSync(questionPath);
        rmSync(answerPath);
        return { content: [{ type: "text", text: answer }], details: {} };
      },
    }),
  );
}
