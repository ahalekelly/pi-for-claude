# pi-run

Delegate implementation tasks to GPT-5.6 with `pi-run`. Each implementation runs in its own persistent git worktree and session; state lives under the main checkout's `.agents/scratchpad/`. Commands must be run from inside the project directory. The project directory must be a git repository, feel free to run `git init` if the directory is specific to the project.

1. Write the plan to `.agents/scratchpad/plans/<name>.md` in the project directory. The plan basename becomes the session id, the branch `pi/<name>`, and the worktree `<main>/.agents/scratchpad/worktrees/<name>`, so pick a unique name — starting a `run` with an existing plan basename fails.

Plan length should be proportional to the task; 1/2th as many tokens as the expected diff is a rough prior.

2. Launch in a `run_in_background` Bash (sandbox off, pi needs provider network access):

   ```sh
   pi-run run .agents/scratchpad/plans/<name>.md
   ```

3. Immediately start a persistent Monitor running `pi-run watch <name>`. Pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks for up to ten minutes waiting for `<session>.answer.md`. Read the question, decide, and write the answer file to unblock the turn; on timeout pi proceeds with its best judgment and reports the assumption.
   
4. While the subagent is running you can also redirect it:

   - `pi-run steer <session> "<message>"` — delivered after the next tool call
   - `pi-run queue <session> "<message>"` — queued until the current agent task finishes
   - `pi-run interrupt <session>` — abort the active turn; the session stays resumable

5. When it completes, read the final response and the worktree diff. Pi leaves changes uncommitted and cannot touch git metadata. Examine the diff for issues, edge cases, subtle bugs, and anywhere pi deviated from your intention — GPT-5.6 can sometimes reward hack without mentioning it.

6. To make changes, use `pi-run resume <session> "<message>"` to ask for further edits, or for minor edits you can edit the worktree files yourself (`queue` only works while a run is still active)

7. To accept the edits, run `pi-run merge <session>` — rebases the private session branch onto the main checkout's current branch, fast-forwards main, and removes the worktree and branch.

   If main moved, `pi-run merge` rebases and stops so verification can be rerun against the new base; run `merge` again after verifying. On rebase conflicts the command reports the conflicted files and leaves the rebase in progress — resolve them yourself, or delegate with `pi-run resume-and-resolve-merge <session> "<instructions>"`, then review the resolution, stage it, `git rebase --continue`, re-verify, and `merge` again.

8. Continue a session with `pi-run resume <session> "<follow-up prompt>"` — same conversation, same worktree. Discard an unwanted session with `pi-run discard <session>` (never `rm` the worktree yourself).

Full pi-run command reference:

- `run <plan-file>` — implement a plan in a new worktree and session; plan path may be relative to the current directory
- `resume <session> <follow-up>` — continue the same pi conversation and worktree; fails while a run is still active
- `resume-and-resolve-merge <session> [instructions]` — continue the session with the active conflict list injected
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `adversarial-review [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label; focus text aims it
- `sessions` — list session ids, originating commands, and worktrees
- `result <session>` — print the last completed assistant response
- `steer <session> <message>` — deliver a message mid-turn, before the next model call
- `queue <session> <message>` — queue work into the live run, taken up after the current agent run settles
- `interrupt <session>` — abort the active turn; the session remains resumable
- `watch <session>` — stream consult questions for a session; prints each question once with the answer-file path, exits when the run ends
- `merge <session>` — rebase, fast-forward main, and clean up the worktree and branch
- `discard <session>` — force-remove the worktree and branch (review sessions: just the metadata record)
- `help` — render prompt names, argument hints, and descriptions

Trailing flags on prompt commands (run/resume/review/adversarial-review):

- `--model <label-or-id>` — override the prompt's model; labels come from `~/.agents/pi-run/models.json` (`default` is gpt-5.6-terra, `best` is gpt-5.6-sol)
- `--thinking <level>` — override the model label's default thinking level
- `--base <ref>` — diff base for reviews
- `--pre <file>` / `--post <file>` — repeatable attachments prepended/appended to the prompt; paths resolve from the current directory
