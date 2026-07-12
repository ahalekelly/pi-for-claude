# pi-run

Delegate implementation tasks to GPT-5.6 in Pi with `pi-run`.

`implement-in-worktree` requires a git repository and creates a persistent worktree session under the main checkout's `.agents/`. `run` edits the project directory directly and also works without git. Commands must run inside the project directory. In a git repository, use `implement-in-worktree` unless the user explicitly asked for in-place work; `run` is for non-git directories and user-requested in-place edits.

## Worktree workflow

1. Write the plan to `.agents/plans/<session>.md` in the project directory. The plan basename becomes the session id, the branch `pi/<session>`, and the worktree `<main>/.agents/worktrees/<session>`, so pick a unique name — starting a session with an existing plan basename fails.

   Plan length should be proportional to the task; 1/2th as many tokens as the expected diff is a rough prior.

2. Launch in a `run_in_background` Bash (sandbox off, pi needs provider network access):

   ```sh
   pi-run implement-in-worktree .agents/plans/<session>.md
   ```

3. Pi can consult you for questions. To facilitate this, immediately start a persistent Monitor:

   ```js
   Monitor({ command: "pi-run watch <session>", description: "pi consult for session <session>", persistent: true, timeout_ms: 300000 })
   ```

   Pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks for up to ten minutes waiting for your response in `<session>.answer.md`. `pi-run watch` will return and close the Monitor after the session is merged or discarded.

4. While the subagent is running, redirect it with `steer`, `queue`, and `interrupt` as needed.

5. When it completes, read the final response and review the session's work. Pi finishes with everything committed on its private branch; its commits and a diffstat against main are appended to the response. Examine Pi's work for errors, oversights, edge cases, subtle bugs, and anywhere pi deviated from your intention — GPT-5.6 can sometimes reward hack without mentioning it. Keep the review from dirtying the worktree (use `npm ci`, not `npm install`), and while any session is in flight, avoid committing to files it is editing — queue changes into the session or hold them until after the merge.

6. Continue a closed session with `pi-run resume <session> "<follow-up prompt>"` — same conversation and worktree. Use this for fixes or additional work that benefits from the prior context.

7. To accept the work, run `pi-run merge <session>` — it rebases onto the main checkout's current branch, fast-forwards pi's commits onto main verbatim, and deletes the worktree and branch.

8. Discard unwanted work with `pi-run discard <session>` (never just delete the worktree directory). Once a worktree is deleted with `merge` or `discard`, the session cannot be resumed, but its logs remain available under `.agents/sessions/`.

## In-place workflow

1. Write the plan to `.agents/plans/<session>.md` in the project directory, then launch `pi-run run .agents/plans/<session>.md`. In a non-git project, this directory is the project root and every pi-run command for the session must run there.

2. Watch, steer, queue, or interrupt the session as usual with `watch`, `steer`, `queue`, and `interrupt`.

3. Review the changes with `git status` and `git diff` where git is available. Use `pi-run resume <session> "<follow-up prompt>"` for fixes.

4. Run `pi-run discard <session>` to close the session. It removes only session metadata and leaves every project file in place; there is no merge step.

## Command reference

- `implement-in-worktree <plan-file>` — implement a plan in a new worktree and session; plan path may be relative to the current directory
- `run <plan-file>` — implement a plan directly in the project directory
- `resume <session> <follow-up>` — continue the same pi conversation in its worktree or project directory
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `adversarial-review [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label; focus text aims it
- `sessions` — list session ids, originating commands, and directories
- `result <session>` — print the last completed assistant response
- `steer <session> <message>` — deliver a message after the next tool call
- `queue <session> <message>` — queue a message until the current agent task finishes
- `interrupt <session>` — abort the active turn; the session remains resumable
- `watch <session>` — stream consult questions for a session; prints each question once with the answer-file path, lives across resumes, exits when the session is merged or discarded
- `merge <session>` — rebase, fast-forward the session's commits onto main, and clean up the worktree and branch
- `discard <session>` — force-remove the worktree and branch, or close a review or in-place session by removing only its metadata record

Trailing flags on prompt commands (implement-in-worktree/run/resume/review/adversarial-review):

- `--model <label-or-id>` — override the prompt's model; labels come from `~/.agents/pi-run/models.json` (`default` is gpt-5.6-terra medium, `best` is gpt-5.6-sol xhigh, `cheap` is gpt-5.6-luna low)
- `--thinking <level>` — override the model label's default thinking level
- `--base <ref>` — diff base for reviews
- `--pre <file>` / `--post <file>` — repeatable attachments prepended/appended to the prompt; paths resolve from the current directory
