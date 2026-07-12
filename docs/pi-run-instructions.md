# pi-run

Delegate implementation tasks to GPT-5.6 in Pi with `pi-run`.

Each implementation runs in its own persistent git worktree and session; state lives under the main checkout's `.agents/`. Commands must be run from inside the project directory. The project directory must be a git repository, feel free to run `git init` if the directory is specific to the project.

1. Write the plan to `.agents/plans/<session>.md` in the project directory. The plan basename becomes the session id, the branch `pi/<session>`, and the worktree `<main>/.agents/worktrees/<session>`, so pick a unique name — starting a session with an existing plan basename fails.

Plan length should be proportional to the task; 1/2th as many tokens as the expected diff is a rough prior.

2. Launch in a `run_in_background` Bash (sandbox off, pi needs provider network access):

   ```sh
   pi-run implement-in-worktree .agents/plans/<session>.md
   ```

3. Pi can consult you for questions. To facilitate this, immediately start a persistent Monitor running `pi-run watch <session>`. Pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks for up to ten minutes waiting for your response in `<session>.answer.md`. `pi-run watch` will automatically return and close the Monitor after session is merged or discarded.
   
4. While the subagent is running you can also redirect it with `steer`, `queue`, and `interrupt`.

5. When it completes, read the final response and review the session's work. Pi finishes with everything committed on its private branch; its commits and a diffstat against main are appended to the response, each command shown with its output. Examine Pi's work for errors, oversights, edge cases, subtle bugs, and anywhere pi deviated from your intention — GPT-5.6 can sometimes reward hack without mentioning it.

6. Continue a closed session with `pi-run resume <session> "<follow-up prompt>"` — same conversation, same worktree. Use this to ask for fixes or additional features that would benefit from the context of a closed session.

7. To accept the work, run `pi-run merge <session>` — rebases onto the main checkout's current branch, fast-forwards pi's commits onto main verbatim, and deletes the worktree and branch.

8. Discard a session's worktree with `pi-run discard <session>` (never just delete the worktree directory). Once a session worktree is deleted with `merge` or `discard`, the session cannot be resumed, but the session logs are still available at `.agents/sessions/<timestamp>_<session>.jsonl` and `.agents/sessions/<session>.log` if you need to review what happened.

Full pi-run command reference:

- `implement-in-worktree <plan-file>` — implement a plan in a new worktree and session; plan path may be relative to the current directory
- `resume <session> <follow-up>` — continue the same pi conversation and worktree
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `adversarial-review [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label; focus text aims it
- `sessions` — list session ids, originating commands, and worktrees
- `result <session>` — print the last completed assistant response
- `steer <session> <message>` — deliver a message after after the next tool call
- `queue <session> <message>` — queue a message to be delivered until the current agent task finishes
- `interrupt <session>` — abort the active turn; the session remains resumable
- `watch <session>` — stream consult questions for a session; prints each question once with the answer-file path, lives across resumes, exits when the session is merged or discarded
- `merge <session>` — rebase, fast-forward the session's commits onto main, and clean up the worktree and branch
- `discard <session>` — force-remove the worktree and branch (review sessions: just the metadata record)

Trailing flags on prompt commands (implement-in-worktree/resume/review/adversarial-review):

- `--model <label-or-id>` — override the prompt's model; labels come from `~/.agents/pi-run/models.json` (`default` is gpt-5.6-terra medium, `best` is gpt-5.6-sol xhigh, `cheap` is gpt-5.6-luna low)
- `--thinking <level>` — override the model label's default thinking level
- `--base <ref>` — diff base for reviews
- `--pre <file>` / `--post <file>` — repeatable attachments prepended/appended to the prompt; paths resolve from the current directory
