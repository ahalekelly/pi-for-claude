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

You are in a git worktree on a private session branch. Commit your work on this branch — never push, and never touch other branches or repository configuration. Check whether main has moved after making your changes and before verification, and rebase onto it if so; check again right before handing back. Finish with a clean tree and a single well-messaged commit (amend or soft-reset your own intermediate commits); the orchestrator fast-forwards your commit onto main verbatim, squashing only if you leave more than one. Delete any scratch files you created or add them to the project's `.gitignore` or `<main>/.git/info/exclude` — uncommitted leftovers block the merge.

When done, summarize what you have done and any deviation from the plan.

$plan
