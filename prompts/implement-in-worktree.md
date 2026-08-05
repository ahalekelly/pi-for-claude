---
description: Implement a plan in a fresh worktree
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write
worktree: create
session: new
consult: |
  Use consult_orchestrator when a missing decision would materially change the implementation; otherwise make the most conservative in-scope assumption and report it.

  `consult_orchestrator(question)` blocks up to 10 minutes for an answer; on timeout, proceed on best judgment and flag the assumption in your summary.

  Consult when the plan is unclear, a deviation seems warranted, you are stuck (recurring errors or a non-converging approach), a rebase conflict's right resolution isn't clear, or approaches have real tradeoffs. Usually one consult, before the approach crystallizes, is enough. If your evidence points one way and the orchestrator's instructions another, surface the conflict ("I found X, you suggest Y") rather than silently switching.
output:
  - pi
  - shell: |
      base_branch="$(git -C "$PI_FOR_CLAUDE_PROJECT" branch --show-current)"
      git log --oneline --no-decorate "$base_branch..HEAD"
      git diff --stat "$base_branch...HEAD"
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later.

Your environment: you are in a git worktree on a private session branch, branched from the project checkout at $project — `git -C $project branch --show-current` names the branch your work merges back into. You are working with an orchestrator agent. You can stage, commit, and rebase this branch and append to the repository's shared exclude file at `$(git rev-parse --path-format=absolute --git-common-dir)/info/exclude`; pushing, other branches, git config, and hooks are blocked. The orchestrator may send you messages mid-run: steering arrives between your tool calls, queued messages arrive after you hand back to the orchestrator.

Handing back: Before testing your changes, always attempt to rebase onto the project checkout's branch. If a rebase conflict is yours to judge, resolve it; otherwise hand back with the rebase still in progress and explain the conflict in your summary, and the orchestrator takes over. Otherwise finish with a clean tree and your work committed with well-written messages. One commit per feature is preferred. Delete scratch files or add them to `.gitignore` or that exclude file if they should be kept — uncommitted leftovers block the merge. If you hand back a dirty tree without an in-progress rebase, the runner sends the problem back to you once; if you still can't hand back cleanly, explain why in your summary — the state is reported to the orchestrator.

After you finish, the orchestrator reviews your commit and may resume this conversation with follow-up requests. Acceptance is `pi-for-claude merge`, which:

1. fails if the worktree is dirty;
2. rebases your branch onto the project branch's current head, pausing on conflicts for resolution;
3. if that branch had moved, stops for re-verification and is run again;
4. fast-forwards your commits onto it verbatim;
5. deletes the worktree and branch — the conversation survives, the worktree does not.

Finish with a thorough report: what you did, deviations from the plan, and interesting findings. The orchestrator sees only your final message and the git status.

$plan
