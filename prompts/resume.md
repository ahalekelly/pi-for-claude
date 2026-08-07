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
      # A standalone project inside some unrelated checkout (e.g. a gitignored
      # scratch dir) must not report that checkout's status, so run git only
      # when the working directory is a work-tree root itself (the project
      # checkout or a session worktree).
      if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then
        git status --short
        git diff --stat
        base_branch="$(git -C "$PI_FOR_CLAUDE_PROJECT" branch --show-current)"
        git log --oneline --no-decorate "$base_branch..HEAD"
      fi
---
$@
