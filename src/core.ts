import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import YAML from "yaml";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

// The strings file itself cannot describe its own corruption, so these two
// bootstrap errors are the only human-language text allowed inline.
export function renderString(stringsPath: string, name: string, injections: Record<string, string>): string {
  const value: unknown = JSON.parse(readFileSync(stringsPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed strings file: ${stringsPath}`);
  const strings = value as Record<string, unknown>;
  const template = strings[name];
  if (typeof template !== "string") throw new Error(`Missing string '${name}' in ${stringsPath}`);
  return renderTemplate(template, [], injections);
}

const stringsPath = join(import.meta.dirname, "..", "prompts", "strings.json");
function msg(name: string, injections: Record<string, string> = {}): string {
  return renderString(stringsPath, name, injections);
}

type ContentEntry = { kind: "text"; text: string } | { kind: "shell"; shell: string };
type InputEntry = { kind: "prompt" } | ContentEntry;
type OutputEntry = { kind: "pi" } | ContentEntry;
type PromptFields = {
  description: string;
  argumentHint: string;
  model: string;
  thinking: { kind: "model-default" } | { kind: "prompt"; level: ThinkingLevel };
  inject: Record<string, string>;
  input: InputEntry[];
  output: OutputEntry[];
  body: string;
};

export type PromptCommand = PromptFields &
  (
    | { mode: "worktree"; sandbox: "worktree-write"; consult: string }
    | { mode: "resume"; sandbox: "worktree-write"; consult: string }
    | { mode: "in-place"; sandbox: "project-write"; consult: string }
    | { mode: "review"; sandbox: "read-only" }
  );

const contentEntrySchema = Type.Union([
  Type.Object({ text: Type.String() }, { additionalProperties: false }),
  Type.Object({ shell: Type.String() }, { additionalProperties: false }),
]);
const promptSchema = Type.Object({
  description: Type.String(),
  "argument-hint": Type.String(),
  model: Type.String(),
  thinking: Type.Optional(Type.Enum(thinkingLevels)),
  mode: Type.Enum(["worktree", "resume", "in-place", "review"]),
  consult: Type.Optional(Type.String()),
  inject: Type.Optional(Type.Record(Type.String(), Type.String())),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("prompt"), contentEntrySchema]))),
  output: Type.Optional(Type.Array(Type.Union([Type.Literal("pi"), contentEntrySchema]))),
}, { additionalProperties: false });
type PromptSource = Static<typeof promptSchema>;

function enumValue<const Values extends readonly string[]>(field: string, value: string, values: Values): Values[number] {
  if (!values.includes(value)) throw new Error(msg("field-must-be-one-of", { field, values: values.join(", ") }));
  return value as Values[number];
}

export function parsePrompt(source: string): PromptCommand {
  const lines = source.split("\n");
  if (lines[0] !== "---") throw new Error(msg("must-start-with-frontmatter"));
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(msg("frontmatter-not-closed"));

  let value: unknown;
  try {
    value = YAML.parse(lines.slice(1, end).join("\n"));
  } catch (error) {
    throw new Error(msg("prompt-frontmatter-yaml-invalid", { error: error instanceof Error ? error.message : String(error) }));
  }
  if (!Check(promptSchema, value)) {
    const error = Errors(promptSchema, value)[0]!;
    const field = error.keyword === "required"
      ? error.params.requiredProperties[0]!
      : error.keyword === "additionalProperties"
        ? error.params.additionalProperties[0]!
        : error.instancePath.slice(1).replaceAll("/", ".") || "frontmatter";
    throw new Error(msg("prompt-frontmatter-invalid", { field, problem: error.message }));
  }
  const prompt: PromptSource = value;

  for (const name of Object.keys(prompt.inject ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(msg("invalid-injection-name", { name }));
  }
  const inputSource = prompt.input ?? ["prompt"];
  if (inputSource.filter((entry) => entry === "prompt").length !== 1) {
    throw new Error(msg("sequence-requires-one-marker", { field: "input", marker: "prompt" }));
  }
  const outputSource = prompt.output ?? ["pi"];
  if (outputSource.filter((entry) => entry === "pi").length !== 1) {
    throw new Error(msg("sequence-requires-one-marker", { field: "output", marker: "pi" }));
  }
  for (const [field, entries] of [["input", inputSource], ["output", outputSource]] as const) {
    for (const entry of entries) {
      if (typeof entry === "string") continue;
      const kind = "text" in entry ? "text" : "shell";
      const content = "text" in entry ? entry.text : entry.shell;
      if (!content.trim()) throw new Error(msg("sequence-entry-empty", { field, kind }));
    }
  }

  const input: InputEntry[] = inputSource.map((entry) => {
    if (entry === "prompt") return { kind: "prompt" };
    if ("text" in entry) return { kind: "text", text: `${entry.text.trimEnd()}\n` };
    return { kind: "shell", shell: `${entry.shell.trimEnd()}\n` };
  });
  const output: OutputEntry[] = outputSource.map((entry) => {
    if (entry === "pi") return { kind: "pi" };
    if ("text" in entry) return { kind: "text", text: `${entry.text.trimEnd()}\n` };
    return { kind: "shell", shell: `${entry.shell.trimEnd()}\n` };
  });
  const fields: PromptFields = {
    description: prompt.description,
    argumentHint: prompt["argument-hint"],
    model: prompt.model,
    thinking: prompt.thinking === undefined ? { kind: "model-default" } : { kind: "prompt", level: prompt.thinking },
    inject: prompt.inject ?? {},
    input,
    output,
    body: lines.slice(end + 1).join("\n"),
  };

  if (prompt.mode === "review") {
    if (prompt.consult !== undefined) throw new Error(msg("review-consult-forbidden"));
    return { ...fields, mode: prompt.mode, sandbox: "read-only" };
  }
  if (prompt.consult === undefined) throw new Error(msg("mode-requires-consult", { mode: prompt.mode }));
  if (prompt.mode === "worktree") return { ...fields, mode: prompt.mode, sandbox: "worktree-write", consult: prompt.consult };
  if (prompt.mode === "resume") return { ...fields, mode: prompt.mode, sandbox: "worktree-write", consult: prompt.consult };
  return { ...fields, mode: prompt.mode, sandbox: "project-write", consult: prompt.consult };
}

export function renderTemplate(body: string, args: string[], injections: Record<string, string>): string {
  const all = args.join(" ");
  const at = (position: number): string => args[position - 1] ?? "";
  const slice = (start: number, length?: number): string =>
    args.slice(start - 1, length === undefined ? undefined : start - 1 + length).join(" ");

  const token = /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$ARGUMENTS|\$@|\$(\d+)|\$([a-z][a-z0-9_]*)/g;
  return body.replace(
    token,
    (match, defaultPosition: string | undefined, fallback: string | undefined, start: string | undefined, length: string | undefined, position: string | undefined, name: string | undefined) => {
      if (defaultPosition) return at(Number(defaultPosition)) || fallback!;
      if (start) return slice(Number(start), length === undefined ? undefined : Number(length));
      if (match === "$@" || match === "$ARGUMENTS") return all;
      if (position) return at(Number(position));
      if (!(name! in injections)) throw new Error(msg("missing-injection", { name: name! }));
      return injections[name!]!;
    },
  );
}

export type ResolvedModel = { model: string; thinking: ThinkingLevel };

export function resolveModel(
  labelOrId: string,
  explicitThinking: string | undefined,
  config: unknown,
  registeredModels: readonly string[],
): ResolvedModel {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(msg("models-not-object"));

  const labels = config as Record<string, unknown>;
  for (const [label, value] of Object.entries(labels)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(msg("model-label-malformed", { label }));
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "model" && key !== "thinking")) throw new Error(msg("model-label-malformed", { label }));
    if (typeof entry.model !== "string" || !entry.model.includes("/")) throw new Error(msg("model-label-no-provider", { label }));
    if (entry.thinking === undefined) throw new Error(msg("model-label-no-thinking", { label }));
    if (typeof entry.thinking !== "string") throw new Error(msg("model-label-non-string-thinking", { label }));
    enumValue(`models.${label}.thinking`, entry.thinking, thinkingLevels);
  }

  const selected = labelOrId.includes("/") ? labelOrId : labels[labelOrId];
  if (selected === undefined) throw new Error(msg("unknown-model-label", { label: labelOrId }));
  const configuredModel = typeof selected === "string" ? selected : (selected as { model: string }).model;
  const wildcardCount = configuredModel.split("*").length - 1;
  if (wildcardCount > 1) throw new Error(msg("model-pattern-malformed", { pattern: configuredModel }));
  let model = configuredModel;
  if (wildcardCount === 1) {
    const expression = new RegExp(`^${configuredModel.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "(\\d+(?:\\.\\d+)?)")}$`);
    const matches = registeredModels.flatMap((candidate) => {
      const match = expression.exec(candidate);
      return match ? [{ candidate, version: match[1]!.split(".").map(Number) }] : [];
    });
    if (matches.length === 0) throw new Error(msg("model-pattern-no-match", { pattern: configuredModel }));
    matches.sort((left, right) => (right.version[0]! - left.version[0]!) || ((right.version[1] ?? 0) - (left.version[1] ?? 0)));
    const [latest, second] = matches;
    if (second && latest!.version[0] === second.version[0] && (latest!.version[1] ?? 0) === (second.version[1] ?? 0)) {
      throw new Error(msg("model-pattern-ambiguous", { pattern: configuredModel }));
    }
    model = latest!.candidate;
  }
  const labelThinking = typeof selected === "string" ? undefined : (selected as { thinking: string }).thinking;
  const thinking = explicitThinking ?? labelThinking;
  if (!thinking) throw new Error(msg("no-thinking-level", { label: labelOrId }));
  return { model, thinking: enumValue("thinking", thinking, thinkingLevels) };
}
