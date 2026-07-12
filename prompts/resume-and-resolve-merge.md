---
description: Continue a session and resolve its rebase conflicts
argument-hint: "<session> [instructions]"
model: default
thinking: high
sandbox: worktree-write
worktree: reuse
session: continue
consult: Use consult_orchestrator when a missing decision would materially change the conflict resolution; otherwise preserve the narrowest compatible behavior and report the assumption.
inject:
  conflicts: git diff --name-only --diff-filter=U
---
Resolve the active rebase conflicts while preserving the thread's implementation intent.

Conflicted files:
$conflicts

Additional instructions:
${@:1}

Do not commit, push, run git rebase --continue, or abort the rebase. Resolve the files and stage nothing; the orchestrator owns git state.
