import { readFileSync } from "node:fs";
import { join } from "node:path";

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
type Sequence = { kind: "input"; entries: InputEntry[] } | { kind: "output"; entries: OutputEntry[] };

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
    | { lifecycle: "create"; sandbox: "worktree-write"; consult: string }
    | { lifecycle: "reuse"; sandbox: "worktree-write"; consult: string }
    | { lifecycle: "in-place"; sandbox: "project-write"; consult: string }
    | { lifecycle: "direct"; sandbox: "read-only" }
  );

const rootFields = new Set([
  "description",
  "argument-hint",
  "model",
  "thinking",
  "sandbox",
  "worktree",
  "session",
  "consult",
  "inject",
  "input",
  "output",
]);

function scalar(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(msg("field-empty", { field }));
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) throw new Error(msg("unterminated-quote", { field }));
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error(msg("unterminated-quote", { field }));
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function enumValue<const Values extends readonly string[]>(field: string, value: string, values: Values): Values[number] {
  if (!values.includes(value)) throw new Error(msg("field-must-be-one-of", { field, values: values.join(", ") }));
  return value as Values[number];
}

function parseSequence(lines: string[], index: number, end: number, sequence: Sequence): number {
  const marker = sequence.kind === "input" ? "prompt" : "pi";
  while (index + 1 < end && (lines[index + 1]!.startsWith("  ") || !lines[index + 1]!.trim())) {
    const entry = lines[index + 1]!;
    if (!entry.trim()) {
      index += 1;
      continue;
    }
    if (entry === `  - ${marker}`) {
      if (sequence.kind === "input") sequence.entries.push({ kind: "prompt" });
      else sequence.entries.push({ kind: "pi" });
      index += 1;
      continue;
    }
    const match = /^  - (text|shell): \|$/.exec(entry);
    if (!match) throw new Error(msg("malformed-sequence-entry", { field: sequence.kind, entry }));
    const kind = match[1] as "text" | "shell";
    const block: string[] = [];
    index += 1;
    while (index + 1 < end && (lines[index + 1]!.startsWith("      ") || !lines[index + 1]!.trim())) {
      const blockLine = lines[index + 1]!;
      block.push(blockLine.trim() ? blockLine.slice(6) : "");
      index += 1;
    }
    if (!block.some((blockLine) => blockLine.trim())) throw new Error(msg("sequence-entry-empty", { field: sequence.kind, kind }));
    const content = `${block.join("\n")}\n`;
    sequence.entries.push(kind === "text" ? { kind, text: content } : { kind, shell: content });
  }
  if (sequence.entries.filter((entry) => entry.kind === marker).length !== 1) {
    throw new Error(msg("sequence-requires-one-marker", { field: sequence.kind, marker }));
  }
  return index;
}

export function parsePrompt(source: string): PromptCommand {
  const lines = source.split("\n");
  if (lines[0] !== "---") throw new Error(msg("must-start-with-frontmatter"));
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(msg("frontmatter-not-closed"));

  const values = new Map<string, string>();
  const inject: Record<string, string> = {};
  const input: PromptFields["input"] = [];
  const output: PromptFields["output"] = [];

  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (line.startsWith(" ")) throw new Error(msg("unexpected-indentation", { line }));

    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(msg("malformed-frontmatter-line", { line }));
    const field = line.slice(0, separator);
    const rawValue = line.slice(separator + 1).trim();
    if (!rootFields.has(field)) throw new Error(msg("unknown-prompt-field", { field }));
    if (values.has(field)) throw new Error(msg("duplicate-prompt-field", { field }));

    if (field === "inject") {
      if (rawValue) throw new Error(msg("inject-must-be-map"));
      values.set(field, "map");
      while (index + 1 < end && lines[index + 1]!.startsWith("  ")) {
        const entry = lines[index + 1]!;
        if (entry.startsWith("   ")) throw new Error(msg("malformed-inject-indentation", { entry }));
        const entrySeparator = entry.indexOf(":", 2);
        if (entrySeparator === -1) throw new Error(msg("malformed-inject-entry", { entry }));
        const name = entry.slice(2, entrySeparator);
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(msg("invalid-injection-name", { name }));
        if (name in inject) throw new Error(msg("duplicate-injection", { name }));
        inject[name] = scalar(entry.slice(entrySeparator + 1), `inject.${name}`);
        index += 1;
      }
      continue;
    }

    if (field === "input" || field === "output") {
      if (rawValue) throw new Error(msg("sequence-must-be-list", { field }));
      values.set(field, "list");
      index = parseSequence(lines, index, end, field === "input" ? { kind: field, entries: input } : { kind: field, entries: output });
      continue;
    }

    values.set(field, scalar(rawValue, field));
  }

  const required = (field: string): string => {
    const value = values.get(field);
    if (!value) throw new Error(msg("missing-prompt-field", { field }));
    return value;
  };

  const sandbox = enumValue("sandbox", required("sandbox"), ["worktree-write", "project-write", "read-only"] as const);
  const worktree = enumValue("worktree", required("worktree"), ["create", "reuse", "none"] as const);
  const session = enumValue("session", required("session"), ["new", "continue"] as const);
  const lifecycle = `${sandbox}:${worktree}:${session}`;
  const fields: PromptFields = {
    description: required("description"),
    argumentHint: required("argument-hint"),
    model: required("model"),
    thinking: values.has("thinking")
      ? { kind: "prompt", level: enumValue("thinking", required("thinking"), thinkingLevels) }
      : { kind: "model-default" },
    inject,
    input: values.has("input") ? input : [{ kind: "prompt" }],
    output: values.has("output") ? output : [{ kind: "pi" }],
    body: lines.slice(end + 1).join("\n"),
  };
  if (lifecycle === "worktree-write:create:new") {
    return { ...fields, lifecycle: "create", sandbox: "worktree-write", consult: required("consult") };
  }
  if (lifecycle === "worktree-write:reuse:continue") {
    return { ...fields, lifecycle: "reuse", sandbox: "worktree-write", consult: required("consult") };
  }
  if (lifecycle === "project-write:none:new") {
    return { ...fields, lifecycle: "in-place", sandbox: "project-write", consult: required("consult") };
  }
  if (lifecycle === "read-only:none:new") return { ...fields, lifecycle: "direct", sandbox: "read-only" };
  throw new Error(msg("invalid-prompt-lifecycle", { sandbox, worktree, session }));
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
  const labelThinking = typeof selected === "string" ? undefined : (selected as { thinking?: unknown }).thinking;
  if (labelThinking !== undefined && typeof labelThinking !== "string") {
    throw new Error(msg("model-label-invalid-thinking", { label: labelOrId }));
  }
  const thinking = explicitThinking ?? labelThinking;
  if (!thinking) throw new Error(msg("no-thinking-level", { label: labelOrId }));
  return { model, thinking: enumValue("thinking", thinking, thinkingLevels) };
}
