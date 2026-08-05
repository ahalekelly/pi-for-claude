---
description: Continue an existing implementation session
argument-hint: "<session> <follow-up>"
model: default
thinking: high
sandbox: worktree-write
worktree: reuse
session: continue
consult: Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.
output:
  - pi
  - shell: |
      git status --short
      git diff --stat
      base_branch="$(git -C "$PI_FOR_CLAUDE_PROJECT" branch --show-current)"
      git log --oneline --no-decorate "$base_branch..HEAD"
---
$@
