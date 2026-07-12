---
description: Implement a plan in the project directory
argument-hint: "<plan-file>"
model: best
thinking: medium
sandbox: project-write
worktree: none
session: new
consult: Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.
output:
  - pi
  - shell: |
      git status --short
      git diff --stat
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later.

Your environment: you are working directly in the user's project directory, which may or may not be a git repository. You cannot run git write operations: `.git` is blocked, so do not stage or commit. Make the changes, delete any scratch files you created, and end with a summary of what you did and any deviation from the plan.

Consult the orchestrator with `consult_orchestrator(question)`, which blocks for up to 10 minutes until the orchestrator answers. On timeout, proceed with your best judgment and flag the assumption in your summary.

Consult when the plan is unclear, if you think a deviation from the plan would be warranted, when stuck (recurring errors or a non-converging approach), or when multiple approaches seem viable but have tradeoffs. On most tasks, one consult before the approach crystallizes is enough. If your evidence points one way and the orchestrator's instructions another, surface the conflict ("I found X, you suggest Y") rather than silently switching.

When done, do a thorough report on what you have done and any deviations from the plan or interesting findings. The orchestrator can only see your final message, and the git diff if you're in a git repo.

$plan
