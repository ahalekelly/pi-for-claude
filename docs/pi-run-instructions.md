# pi-run

Delegate implementation tasks to pi with `pi-run`. Each implementation runs in its own persistent git worktree and session; state lives under the main checkout's `.agents/scratchpad/` even when you point it at a linked worktree.

1. Write the plan to `$PROJECT_DIR/.agents/scratchpad/plans/<name>.md`. The plan basename becomes the session id, the branch `pi/<name>`, and the worktree `<main>/.agents/scratchpad/worktrees/<name>`, so pick a unique name — starting a `run` with an existing plan basename fails. Plan length should be roughly proportional to the task; 1/10th as many tokens as the expected diff is a rough prior.

2. Launch in a `run_in_background` Bash (sandbox off, pi needs provider network access):

   ```sh
   pi-run run "$PROJECT_DIR" .agents/scratchpad/plans/<name>.md
   ```

3. Immediately start a Monitor on `<main>/.agents/scratchpad/pi/sessions/` for `*.question.md`. During a live turn pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks for up to ten minutes waiting for `<session>.answer.md`. Read the question, decide, and write the answer file to unblock the turn; on timeout pi proceeds with its best judgment and reports the assumption. While a turn is running you can also redirect it:

   - `pi-run steer "$PROJECT_DIR" <session> "<message>"` — delivered after the current tool calls, before the next model call
   - `pi-run followup "$PROJECT_DIR" <session> "<message>"` — queued until the current agent run settles
   - `pi-run interrupt "$PROJECT_DIR" <session>` — abort the active turn; the session stays resumable

4. When it completes, read the final response (`pi-run result "$PROJECT_DIR" <session>`) and the worktree diff. Pi leaves changes uncommitted and cannot touch git metadata. Examine the diff for issues, edge cases, subtle bugs, and anywhere pi deviated from your intention — pi can sometimes reward hack without mentioning it. Then:

   1. Run the project's verification in the worktree.
   2. Commit the reviewed changes on the session branch.
   3. Run `pi-run merge "$PROJECT_DIR" <session>` — rebases the private session branch onto the main checkout's current branch, fast-forwards main, and removes the worktree and branch.

   If main moved, `merge` rebases and stops so verification can be rerun against the new base; run `merge` again after verifying. On rebase conflicts the command reports the conflicted files and leaves the rebase in progress — resolve them yourself, or delegate with `pi-run resume-and-resolve-merge "$PROJECT_DIR" <session> "<instructions>"`, then review the resolution, stage it, `git rebase --continue`, re-verify, and `merge` again. The runner never chooses a conflict resolution.

5. Continue a session with `pi-run resume "$PROJECT_DIR" <session> "<follow-up prompt>"` — same conversation, same worktree. Discard an unwanted session with `pi-run discard "$PROJECT_DIR" <session>` (never `rm` the worktree yourself).

Full pi-run command reference:

- `run <project> <plan-file>` — implement a plan in a new worktree and session; plan path may be relative to the project dir
- `resume <project> <session> <follow-up>` — continue the same pi conversation and worktree
- `resume-and-resolve-merge <project> <session> [instructions]` — continue the session with the active conflict list injected
- `review <project> [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `adversarial-review <project> [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label; focus text aims it
- `sessions <project>` — list session ids, originating commands, and worktrees
- `result <project> <session>` — print the last completed assistant response
- `steer <project> <session> <message>` — deliver a message mid-turn, before the next model call
- `followup <project> <session> <message>` — queue work after the current agent run settles
- `interrupt <project> <session>` — abort the active turn; the session remains resumable
- `merge <project> <session>` — rebase, fast-forward main, and clean up the worktree and branch
- `discard <project> <session>` — force-remove the worktree and branch (review sessions: just the metadata record)
- `help` — render prompt names, argument hints, and descriptions

Trailing flags on prompt commands (run/resume/review/adversarial-review):

- `--model <label-or-id>` — override the prompt's model; labels come from `~/.agents/pi-run/models.json` (`default` is gpt-5.6-terra, `best` is gpt-5.6-sol)
- `--thinking <level>` — override the model label's default thinking level
- `--base <ref>` — diff base for reviews
- `--pre <file>` / `--post <file>` — repeatable attachments prepended/appended to the prompt; paths resolve from the project dir
