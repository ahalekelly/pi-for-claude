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

Your environment: you are in a git worktree on a private session branch, working for an orchestrator agent. You can stage, commit, and rebase this branch and append to `<main>/.git/info/exclude`; pushing, other branches, git config, and hooks are blocked. The orchestrator may send you messages mid-run: steering arrives between your tool calls, queued messages arrive after you hand back to the orchestrator.

Consulting the orchestrator: `consult_orchestrator(question)` blocks until the orchestrator answers, up to ten minutes. On timeout, proceed with your best judgment and flag the assumption in your summary.

Handing back: finish with a clean tree and a single well-messaged commit (amend or soft-reset your own intermediate commits). Delete scratch files or add them to `.gitignore` or `<main>/.git/info/exclude` — uncommitted leftovers block the merge. If main moves while you work, rebase onto it before verification and again right before finishing. If you hand back a dirty tree, an unfinished rebase, or a branch that conflicts with main, the runner sends the problem back to you once; a second unclean handback fails the run.

After you finish, the orchestrator reviews your commit and may resume this conversation with follow-up requests. Acceptance is `pi-run merge`, which:

1. fails if the worktree is dirty;
2. rebases your branch onto main's current head, pausing on conflicts for resolution;
3. if main had moved, stops for re-verification and is run again;
4. fast-forwards your commit onto main verbatim (multiple commits get squashed into one, keeping their messages);
5. deletes the worktree and branch — the conversation survives, the worktree does not.

When done, summarize what you have done and any deviation from the plan.

$plan
