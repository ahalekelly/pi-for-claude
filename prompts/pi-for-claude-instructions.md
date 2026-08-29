# pi-for-claude

Delegate tasks to GPT agents in Pi with `pi-for-claude`.

`implement-in-worktree` requires git and gives each session a private checkout under the launch checkout's `.agents/`; use it to run agents in parallel. `run` edits the project directory in place and also works without git. Run commands from the project root: the checkout you launch from is the project, so a linked worktree keeps its own sessions, private Pi checkouts, and merge target. A gitignored subdirectory counts as a standalone non-git project.

## Isolated Git workflow

1. Write the plan to `.agents/plans/<session>.md` in the git project directory. The plan basename becomes the session id, private branch `pi/<session>`, and checkout `<project>/.agents/worktrees/<session>`, so pick a unique name.

   Plan length should be proportional to the task; half as many tokens as the expected diff is a rough prior.

2. Launch the run with unsandboxed background Bash, then follow it in a Monitor:

   ```js
   Bash({ command: "nohup pi-for-claude implement-in-worktree .agents/plans/<session>.md > /dev/null 2>&1 &", dangerouslyDisableSandbox: true })
   Monitor({ command: "pi-for-claude watch <session>", description: "Pi session <session>", persistent: true, timeout_ms: 300000 })
   ```

   Pi's command sandbox cannot start inside Claude Code's sandbox, and Monitor is always sandboxed, so pi-for-claude refuses to start sessions there.

3. Pi can call `consult_orchestrator(question)`, which writes question and answer files under `.agents/sessions/<session>/` and waits up to ten minutes. The Monitor emits the question and answer-file path. Restate both in a user reply — the user cannot see Monitor event bodies. With `--no-consult`, Pi proceeds without asking.

4. While the subagent is running, redirect it with `steer`, `queue`, and `interrupt`.

5. When it completes, review the work: Pi finishes with everything committed in its private checkout, and its commits and a diffstat against the project branch are appended to the response. Check errors, edge cases, and deviations from the plan. Keep the private checkout clean while reviewing (`npm ci`, not `npm install`) and queue changes into a live session rather than editing its files yourself. If `merge` refuses because the project checkout has uncommitted edits: `git stash`, merge, `git stash pop`.

6. Continue a settled session with the same launch pattern — same conversation and checkout:

   ```js
   Bash({ command: "nohup pi-for-claude resume <session> \"<follow-up prompt>\" > /dev/null 2>&1 &", dangerouslyDisableSandbox: true })
   Monitor({ command: "pi-for-claude watch <session>", description: "Pi session <session>", persistent: true, timeout_ms: 300000 })
   ```

7. Accept with `pi-for-claude merge <session>`: it rebases in the private repository, imports the verified commit, fast-forwards the project branch, and moves the private checkout to the trash.

8. Discard with `pi-for-claude discard <session>`. After merge or discard the session cannot be resumed; its conversation, turn state, result, and logs remain under `.agents/sessions/<session>/`.

## In-place workflow

1. Write the plan to `.agents/plans/<session>.md` in the project directory. In a non-git project, run every command for the session from that directory.

2. Launch with unsandboxed background Bash, then follow it in a Monitor; steer, queue, or interrupt as usual.

   ```js
   Bash({ command: "nohup pi-for-claude run .agents/plans/<session>.md > /dev/null 2>&1 &", dangerouslyDisableSandbox: true })
   Monitor({ command: "pi-for-claude watch <session>", description: "Pi session <session>", persistent: true, timeout_ms: 300000 })
   ```

3. When Pi finishes, the changes are shown with `git status` and `git diff` if the project directory is itself a git checkout; a standalone project (including a gitignored scratch dir inside some other repository) shows no git output. Use `resume` for follow-ups.

4. Close with `pi-for-claude discard <session>`: it closes the session and leaves project files in place; without a private checkout there is no `merge`.

## Command reference

- `implement-in-worktree <plan-file>` — implement a plan in a private Git checkout
- `run <plan-file>` — implement a plan directly in the project directory
- `resume <session> <follow-up>` — continue the same Pi conversation in its checkout or project directory
- `review [session] [focus] [--base <ref>]` — read-only review of the project or private session checkout; the first argument is focus text unless it names an existing session
- `sessions` — list session ids, originating commands, and directories
- `result <session>` — print the persisted result from the last settled turn; reject a running or failed turn
- `view <session> [--no-open]` — export the conversation to HTML beside its JSONL and open it
- `watch <session>` — replay and follow the current turn; exits when that turn settles, or exits 1 when it fails
- `steer <session> <message>` — deliver a message after the next tool call
- `queue <session> <message>` — queue a message until the current agent task finishes
- `interrupt <session>` — abort the active turn; the session remains resumable
- `merge <session>` — import verified commits, fast-forward the project branch, and close the session
- `discard <session>` — close the session and move its private checkout to the trash
- `version` — show the running package version, revision, executable, and latest published version

Trailing flags on prompt commands (implement-in-worktree/run/resume/review):

- `--model <label-or-id>` — labels come from the pi-for-claude checkout's `models.json`: `default` is the latest openai-codex Sol model at medium, `best` the same at xhigh, `cheap` the latest Luna model at medium
- `--thinking <level>` — override the label's thinking level
- `--base <ref>` — diff base for reviews
- `--no-consult` — unattended run: removes the consult tool, so Pi makes conservative assumptions and reports them instead of blocking on questions
- `--prepend <file>` / `--append <file>` — attach text files to the prompt; paths resolve from the current directory

<!-- pi-scoped-models:start -->
## Pi scoped models

This list is generated from Pi's saved `/scoped-models` configuration.

Pi has no saved model scope.
<!-- pi-scoped-models:end -->
