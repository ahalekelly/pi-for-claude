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

You are in a git worktree on a private session branch. Do not run git commit or git push; if main moves while you work, the orchestrator's merge rebases your branch — don't track it yourself. When your work is accepted, everything in the worktree that git doesn't ignore is committed as one squash commit (via `git add -A`), so before finishing, delete any scratch files you created or add them to the project's `.gitignore`.

When done, summarize what you have done and any deviation from the plan.

$plan
