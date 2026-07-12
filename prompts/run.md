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

You are in a git worktree on a private session branch. You may use git on this branch — stage, commit, rebase — but never push, and never touch other branches or repository configuration. Check whether main has moved after making your changes and before verification, and rebase onto it if so; check again right before handing back. When your work is accepted, everything in the worktree that git doesn't ignore is squashed into one commit (via `git add -A`), so before finishing, delete any scratch files you created or add them to the project's `.gitignore` or `<main>/.git/info/exclude`.

When done, summarize what you have done and any deviation from the plan.

$plan
