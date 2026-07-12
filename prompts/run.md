---
description: Implement a plan in the project directory
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: project-write
worktree: none
session: new
consult: Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.
output-append: |
  git status --short
  git diff --stat
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later.

Your environment: you are working directly in the user's project directory, which might not be a git repository. You cannot run git write operations: `.git` is blocked, so do not stage or commit. Make the changes, delete any scratch files you created, and end your summary with what you changed and any deviation from the plan. The orchestrator may send you messages mid-run: steering arrives between your tool calls, queued messages arrive after you hand back to the orchestrator.

Consulting the orchestrator: `consult_orchestrator(question)` blocks until the orchestrator answers, up to ten minutes. On timeout, proceed with your best judgment and flag the assumption in your summary.

When done, summarize what you have done and any deviation from the plan.

$plan
