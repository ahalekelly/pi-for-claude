---
description: Implement a plan in a fresh worktree
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.
output-append: |
  git status --short
  git diff --stat
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later.

Do not run git commit or git push. The orchestrator reviews the diff and commits.

When done, summarize what you changed and any deviation from the plan.

$plan
