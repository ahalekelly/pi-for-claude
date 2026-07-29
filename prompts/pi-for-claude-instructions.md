# pi-for-claude

Delegate tasks to GPT agents in Pi with `pi-for-claude`.

`implement-in-worktree` requires a git repository and creates a persistent worktree session under the main checkout's `.agents/`. `run` edits the project directory directly and also works without git. Commands must run inside the project directory. In a git repository, use `implement-in-worktree` when running multiple agents simultaneously, `run` is for non-git directories and single-subagent workflows.

## Worktree workflow

1. Write the plan to `.agents/plans/<session>.md` in the git project directory. The plan basename becomes the session id, the branch `pi/<session>`, and the worktree `<main>/.agents/worktrees/<session>`, so pick a unique name — starting a session with an existing plan basename fails.

   Plan length should be proportional to the task; 1/2th as many tokens as the expected diff is a rough prior.

2. Launch the run in a plain persistent Monitor. The sandbox permits provider traffic, and `pi-for-claude setup` grants the authentication-file writes and loopback binding used by the session:

   ```js
   Monitor({ command: "pi-for-claude implement-in-worktree .agents/plans/<session>.md", description: "Pi session <session>", persistent: true, timeout_ms: 300000 })
   ```

   Exception: Pi's locally-executing web tools (`agent_browser`, `fetch_content`) break when pi-for-claude runs inside the Claude sandbox — nested sandboxing fails with `sandbox-exec` EPERM, an unwritable browser socket dir, and DNS ENOTFOUND — and Monitor is always sandboxed. Launch sessions that need those tools via unsandboxed background Bash instead (`nohup pi-for-claude run … &`), then attach a plain sandboxed Monitor with `pi-for-claude watch <session>`: it replays and follows the session's output (consult questions, stall warnings, final report) and exits when the session settles. Launch first, then attach. Steer, queue, and consult work as usual. Provider-side `web_search` runs on OpenAI's servers and works fine sandboxed.

3. Pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks for up to ten minutes waiting for your response in `<session>.answer.md`. The run's Monitor emits the question and answer-file path. Restate the question and your answer in a user reply because the user cannot see Monitor event bodies. Runs launched with `--no-consult` never ask.

4. While the subagent is running, redirect it with `steer`, `queue`, and `interrupt` as needed.

5. When it completes, read the final response and review the session's work. Pi finishes with everything committed on its private branch; its commits and a diffstat against main are appended to the response. Examine Pi's work for errors, oversights, edge cases, subtle bugs, and anywhere pi deviated from your intention — GPT-5.6 can sometimes reward hack without mentioning it. Keep the review from dirtying the worktree (use `npm ci`, not `npm install`), and while any session is in flight, avoid committing to files it is editing — queue changes into the session or hold them until after the merge. If `merge` refuses because the main checkout has uncommitted edits, `git stash` them, merge, then `git stash pop` — committing them mid-merge just creates the next rebase conflict.

6. Continue a closed session by launching `pi-for-claude resume <session> "<follow-up prompt>"` in a new persistent Monitor — same conversation and worktree. Use this for fixes or additional work that benefits from the prior context.

7. To accept the work, run `pi-for-claude merge <session>` — it rebases onto the main checkout's current branch, fast-forwards pi's commits onto main verbatim, and deletes the worktree and branch.

8. Discard unwanted work with `pi-for-claude discard <session>` (never just delete the worktree directory). Once a worktree is deleted with `merge` or `discard`, the session cannot be resumed, but its timestamp-prefixed logs remain available under `.agents/sessions/`.

## In-place workflow

1. Write the plan to `.agents/plans/<session>.md` in the project directory. In a non-git project, this directory is the project root and every pi-for-claude command for the session must run there.

2. As above, launch `pi-for-claude run .agents/plans/<session>.md` in a Monitor, and steer, queue, or interrupt the session as usual.

3. When Pi finishes, the changes will be shown with `git status` and `git diff` if a git repo is available. Use `pi-for-claude resume <session> "<follow-up prompt>"` for related changes.

4. Run `pi-for-claude discard <session>` to close the session. It removes only session metadata and leaves every project file in place; without a worktree there is no `merge` command.

## Command reference

- `implement-in-worktree <plan-file>` — implement a plan in a new worktree and session; plan path may be relative to the current directory
- `run <plan-file>` — implement a plan directly in the project directory
- `resume <session> <follow-up>` — continue the same pi conversation in its worktree or project directory
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `sessions` — list session ids, originating commands, and directories
- `result <session>` — print the last completed assistant response
- `view <session> [--no-open]` — export the conversation beside its JSONL as HTML and open it in the default browser
- `watch <session>` — replay and follow a session's output from its log; exits when the session settles (for sessions launched outside a Monitor)
- `steer <session> <message>` — deliver a message after the next tool call
- `queue <session> <message>` — queue a message until the current agent task finishes
- `interrupt <session>` — abort the active turn; the session remains resumable
- `merge <session>` — rebase, fast-forward the session's commits onto main, and clean up the worktree and branch
- `discard <session>` — force-remove the worktree and branch, or close a review or in-place session by removing only its metadata record

Trailing flags on prompt commands (implement-in-worktree/run/resume/review):

- `--model <label-or-id>` — override the prompt's model; labels come from the pi-for-claude checkout's `models.json` (`default` selects the latest openai-codex Sol model at medium, `best` selects it at xhigh, and `cheap` selects the latest Luna model at medium)
- `--thinking <level>` — override the model label's default thinking level
- `--base <ref>` — diff base for reviews
- `--no-consult` — unattended run: removes the consult tool and its guidance, so Pi makes conservative assumptions and reports them instead of blocking on questions
- `--prepend <file>` / `--append <file>` — prepend/append text files to the prompt; paths resolve from the current directory

<!-- pi-scoped-models:start -->
## Pi scoped models

This list is generated from Pi's saved `/scoped-models` configuration.

- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-5.6-luna`
- `google/gemini-flash-latest`
<!-- pi-scoped-models:end -->
