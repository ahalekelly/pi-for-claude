export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

type PromptFields = {
  description: string;
  argumentHint: string;
  model: string;
  thinking: { kind: "model-default" } | { kind: "prompt"; level: ThinkingLevel };
  inject: Record<string, string>;
  outputAppend: string;
  body: string;
};

export type PromptCommand = PromptFields &
  (
    | { lifecycle: "create"; sandbox: "worktree-write"; consult: string }
    | { lifecycle: "reuse"; sandbox: "worktree-write"; consult: string }
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
  "output-append",
]);

function scalar(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Prompt field '${field}' must not be empty`);
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) throw new Error(`Prompt field '${field}' has an unterminated quote`);
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error(`Prompt field '${field}' has an unterminated quote`);
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function enumValue<const Values extends readonly string[]>(field: string, value: string, values: Values): Values[number] {
  if (!values.includes(value)) throw new Error(`Prompt field '${field}' must be one of: ${values.join(", ")}`);
  return value as Values[number];
}

export function parsePrompt(source: string): PromptCommand {
  const lines = source.split("\n");
  if (lines[0] !== "---") throw new Error("Prompt must start with frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("Prompt frontmatter is not closed");

  const values = new Map<string, string>();
  const inject: Record<string, string> = {};
  let outputAppend = "";

  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (line.startsWith(" ")) throw new Error(`Unexpected indentation in prompt frontmatter: ${line}`);

    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`Malformed prompt frontmatter line: ${line}`);
    const field = line.slice(0, separator);
    const rawValue = line.slice(separator + 1).trim();
    if (!rootFields.has(field)) throw new Error(`Unknown prompt field '${field}'`);
    if (values.has(field)) throw new Error(`Duplicate prompt field '${field}'`);

    if (field === "inject") {
      if (rawValue) throw new Error("Prompt field 'inject' must be a nested map");
      values.set(field, "map");
      while (index + 1 < end && lines[index + 1]!.startsWith("  ")) {
        const entry = lines[index + 1]!;
        if (entry.startsWith("   ")) throw new Error(`Malformed inject indentation: ${entry}`);
        const entrySeparator = entry.indexOf(":", 2);
        if (entrySeparator === -1) throw new Error(`Malformed inject entry: ${entry}`);
        const name = entry.slice(2, entrySeparator);
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid injection name '${name}'`);
        if (name in inject) throw new Error(`Duplicate injection '${name}'`);
        inject[name] = scalar(entry.slice(entrySeparator + 1), `inject.${name}`);
        index += 1;
      }
      continue;
    }

    if (field === "output-append") {
      if (rawValue !== "|") throw new Error("Prompt field 'output-append' must use a | block");
      values.set(field, "block");
      const block: string[] = [];
      while (index + 1 < end && (lines[index + 1]!.startsWith("  ") || !lines[index + 1]!.trim())) {
        const blockLine = lines[index + 1]!;
        if (blockLine.trim() && !blockLine.startsWith("  ")) throw new Error(`Malformed output-append indentation: ${blockLine}`);
        block.push(blockLine.slice(2));
        index += 1;
      }
      outputAppend = `${block.join("\n")}\n`;
      continue;
    }

    values.set(field, scalar(rawValue, field));
  }

  const required = (field: string): string => {
    const value = values.get(field);
    if (!value) throw new Error(`Missing prompt field '${field}'`);
    return value;
  };

  const sandbox = enumValue("sandbox", required("sandbox"), ["worktree-write", "read-only"] as const);
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
    outputAppend,
    body: lines.slice(end + 1).join("\n"),
  };
  if (lifecycle === "worktree-write:create:new") {
    return { ...fields, lifecycle: "create", sandbox: "worktree-write", consult: required("consult") };
  }
  if (lifecycle === "worktree-write:reuse:continue") {
    return { ...fields, lifecycle: "reuse", sandbox: "worktree-write", consult: required("consult") };
  }
  if (lifecycle === "read-only:none:new") return { ...fields, lifecycle: "direct", sandbox: "read-only" };
  throw new Error(`Invalid prompt lifecycle: sandbox=${sandbox}, worktree=${worktree}, session=${session}`);
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
      if (!(name! in injections)) throw new Error(`Missing injection '${name}'`);
      return injections[name!]!;
    },
  );
}

export type ResolvedModel = { model: string; thinking: ThinkingLevel };

export function resolveModel(
  labelOrId: string,
  explicitThinking: string | undefined,
  config: unknown,
): ResolvedModel {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("models.json must contain an object");

  const labels = config as Record<string, unknown>;
  for (const [label, value] of Object.entries(labels)) {
    if (typeof value === "string") {
      if (!value.includes("/")) throw new Error(`Model label '${label}' must contain a provider/model id`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Model label '${label}' is malformed`);
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "model" && key !== "thinking")) throw new Error(`Model label '${label}' is malformed`);
    if (typeof entry.model !== "string" || !entry.model.includes("/")) throw new Error(`Model label '${label}' must contain a provider/model id`);
    if (entry.thinking !== undefined) {
      if (typeof entry.thinking !== "string") throw new Error(`Model label '${label}' has a non-string thinking level`);
      enumValue(`models.${label}.thinking`, entry.thinking, thinkingLevels);
    }
  }

  const selected = labelOrId.includes("/") ? labelOrId : labels[labelOrId];
  if (selected === undefined) throw new Error(`Unknown model label '${labelOrId}'`);
  const model = typeof selected === "string" ? selected : (selected as { model: string }).model;
  const labelThinking = typeof selected === "string" ? undefined : (selected as { thinking?: unknown }).thinking;
  if (labelThinking !== undefined && typeof labelThinking !== "string") {
    throw new Error(`Model label '${labelOrId}' has an invalid thinking level`);
  }
  const thinking = explicitThinking ?? labelThinking;
  if (!thinking) throw new Error(`No thinking level configured for model '${labelOrId}'`);
  return { model, thinking: enumValue("thinking", thinking, thinkingLevels) };
}
