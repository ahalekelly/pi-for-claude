import assert from "node:assert/strict";
import test from "node:test";

import { parsePrompt, renderTemplate, resolveModel } from "../src/core.ts";

test("parsePrompt exposes a complete command definition", () => {
  const command = parsePrompt(`---
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
output-append: |
  git status --short
  git diff --stat
---
Implement $plan on $branch.
`);

  assert.deepEqual(command, {
    description: "Implement a plan",
    argumentHint: "<plan-file>",
    model: "default",
    thinking: { kind: "prompt", level: "high" },
    lifecycle: "create",
    sandbox: "worktree-write",
    consult: "Ask when blocked",
    inject: { branch: "git branch --show-current" },
    outputAppend: "git status --short\ngit diff --stat\n",
    body: "Implement $plan on $branch.\n",
  });
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
    default: "openai-codex/gpt-5.6-terra",
    best: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
  };

  assert.deepEqual(resolveModel("best", undefined, config), {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "xhigh",
  });
  assert.deepEqual(resolveModel("default", "high", config), {
    model: "openai-codex/gpt-5.6-terra",
    thinking: "high",
  });
  assert.deepEqual(resolveModel("openai-codex/gpt-custom", "medium", config), {
    model: "openai-codex/gpt-custom",
    thinking: "medium",
  });
});

test("resolveModel validates every configured label", () => {
  assert.throws(
    () => resolveModel("openai-codex/gpt-test", "high", { broken: { model: "openai-codex/gpt-test", thinking: 42 } }),
    /non-string thinking level/,
  );
  assert.throws(() => resolveModel("empty", "high", { empty: "" }), /provider\/model id/);
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
