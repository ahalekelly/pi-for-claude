import assert from "node:assert/strict";
import test from "node:test";

import { parsePrompt, renderTemplate, resolveModel } from "../src/core.ts";

test("parsePrompt exposes a complete command definition", () => {
  const source = `---
description: Implement a plan
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: Ask when blocked
inject:
  branch: git branch --show-current
input:
  - shell: |
      printf 'Repository context'
  - text: |
      Additional instructions
  - prompt
  - text: |
      Final input note
output:
  - text: |
      Before Pi:
  - shell: |
      git status --short
  - pi
  - text: |
      After Pi:
  - shell: |
      git diff --stat
---
Implement $plan on $branch.
`;
  const command = parsePrompt(source);

  assert.deepEqual(command, {
    description: "Implement a plan",
    argumentHint: "<plan-file>",
    model: "default",
    thinking: { kind: "prompt", level: "high" },
    lifecycle: "create",
    sandbox: "worktree-write",
    consult: "Ask when blocked",
    inject: { branch: "git branch --show-current" },
    input: [
      { kind: "shell", shell: "printf 'Repository context'\n" },
      { kind: "text", text: "Additional instructions\n" },
      { kind: "prompt" },
      { kind: "text", text: "Final input note\n" },
    ],
    output: [
      { kind: "text", text: "Before Pi:\n" },
      { kind: "shell", shell: "git status --short\n" },
      { kind: "pi" },
      { kind: "text", text: "After Pi:\n" },
      { kind: "shell", shell: "git diff --stat\n" },
    ],
    body: "Implement $plan on $branch.\n",
  });

  assert.throws(() => parsePrompt(source.replace("  - prompt\n", "")), /must contain exactly one '- prompt' entry/);
  assert.throws(() => parsePrompt(source.replace("  - prompt\n", "  - prompt\n  - prompt\n")), /must contain exactly one '- prompt' entry/);
  assert.throws(() => parsePrompt(source.replace("  - pi\n", "")), /must contain exactly one '- pi' entry/);
  assert.throws(() => parsePrompt(source.replace("  - pi\n", "  - pi\n  - pi\n")), /must contain exactly one '- pi' entry/);
});

test("parsePrompt supports in-place project writes", () => {
  assert.deepEqual(
    parsePrompt(`---
description: Implement in place
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: project-write
worktree: none
session: new
consult: Ask when blocked
---
$plan
`),
    {
      description: "Implement in place",
      argumentHint: "<plan-file>",
      model: "default",
      thinking: { kind: "prompt", level: "high" },
      lifecycle: "in-place",
      sandbox: "project-write",
      consult: "Ask when blocked",
      inject: {},
      input: [{ kind: "prompt" }],
      output: [{ kind: "pi" }],
      body: "$plan\n",
    },
  );
});

test("renderTemplate expands pi arguments and injected values", () => {
  assert.equal(
    renderTemplate(
      "$1 / $@ / $ARGUMENTS / ${1:-fallback} / ${2:-fallback} / ${@:2} / ${@:2:1} / $branch",
      ["one", "two", "three"],
      { branch: "main" },
    ),
    "one / one two three / one two three / one / two / two three / two / main",
  );
});

test("renderTemplate rejects a missing injection", () => {
  assert.throws(() => renderTemplate("Review $branch", [], {}), /Missing injection 'branch'/);
});

test("renderTemplate does not expand tokens inside inserted values", () => {
  assert.equal(renderTemplate("Follow up: $@\n$plan", ["echo $i"], { plan: "cost is $5" }), "Follow up: echo $i\ncost is $5");
});

test("resolveModel applies explicit, label, and literal model settings", () => {
  const config = {
    default: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
    best: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
  };

  assert.deepEqual(resolveModel("best", undefined, config, []), {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "xhigh",
  });
  assert.deepEqual(resolveModel("default", "high", config, []), {
    model: "openai-codex/gpt-5.6-terra",
    thinking: "high",
  });
  assert.deepEqual(resolveModel("openai-codex/gpt-custom", "medium", config, []), {
    model: "openai-codex/gpt-custom",
    thinking: "medium",
  });
});

test("resolveModel selects the highest matching model from the requested provider", () => {
  const config = { latest: { model: "openai-codex/gpt-*-sol", thinking: "medium" } };
  const registeredModels = [
    "openai/gpt-9.9-sol",
    "openai-codex/gpt-5-sol",
    "openai-codex/gpt-5.9-sol",
    "openai-codex/gpt-5.10-sol",
    "openai-codex/gpt-6-luna",
  ];

  assert.deepEqual(resolveModel("latest", undefined, config, registeredModels), {
    model: "openai-codex/gpt-5.10-sol",
    thinking: "medium",
  });
  assert.throws(() => resolveModel("latest", undefined, config, []), /does not match a registered model/);
});

test("resolveModel validates every configured label", () => {
  assert.throws(
    () => resolveModel("openai-codex/gpt-test", "high", { shorthand: "openai-codex/gpt-test" }, []),
    /Model label 'shorthand' is malformed/,
  );
  assert.throws(
    () => resolveModel("openai-codex/gpt-test", "high", { missing: { model: "openai-codex/gpt-test" } }, []),
    /must contain a thinking level/,
  );
  assert.throws(
    () => resolveModel("openai-codex/gpt-test", "high", { broken: { model: "openai-codex/gpt-test", thinking: 42 } }, []),
    /non-string thinking level/,
  );
  assert.throws(() => resolveModel("empty", "high", { empty: {} }, []), /provider\/model id/);
});

test("parsePrompt rejects unknown fields and invalid states", () => {
  assert.throws(() => parsePrompt("---\ndescription: test\nsurprise: no\n---\nbody"), /Unknown prompt field/);
  assert.throws(
    () =>
      parsePrompt(`---
description: test
argument-hint: none
model: default
thinking: high
sandbox: unsafe
worktree: none
session: new
---
body`),
    /Prompt field 'sandbox' must be one of/,
  );
  assert.throws(
    () =>
      parsePrompt(`---
description: test
argument-hint: none
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: continue
---
body`),
    /Invalid prompt lifecycle/,
  );
});
