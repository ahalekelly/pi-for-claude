---
description: Implement a plan in the project directory
argument-hint: "<plan-file>"
model: best
thinking: medium
sandbox: project-write
worktree: none
session: new
consult: |
  Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.

  `consult_orchestrator(question)` blocks up to 10 minutes for an answer; on timeout, proceed on best judgment and flag the assumption in your summary.

  Consult when the plan is unclear, a deviation seems warranted, you are stuck (recurring errors or a non-converging approach), or approaches have real tradeoffs. Usually one consult, before the approach crystallizes, is enough. If your evidence points one way and the orchestrator's instructions another, surface the conflict ("I found X, you suggest Y") rather than silently switching.
output:
  - pi
  - shell: |
      git status --short
      git diff --stat
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later.

Your environment: you are working directly in the user's project directory, which may or may not be a git repository. You cannot run git write operations: `.git` is blocked, so do not stage or commit. Delete any scratch files you created.

Finish with a thorough report: what you did, deviations from the plan, and interesting findings. The orchestrator sees only your final message, and the git diff if you're in a git repo.

$plan
