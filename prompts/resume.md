---
description: Continue an existing implementation session
argument-hint: "<session> <follow-up>"
model: default
thinking: high
sandbox: worktree-write
worktree: reuse
session: continue
consult: Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.
output-append: |
  main_branch="$(git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." branch --show-current)"
  git log --oneline --no-decorate "$main_branch..HEAD"
  git diff --stat "$main_branch...HEAD"
---
$@
