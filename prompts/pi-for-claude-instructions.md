# pi-for-claude

Delegate tasks to GPT agents in Pi with `pi-for-claude`.

`implement-in-worktree` requires a git repository and creates a persistent worktree session under the launch checkout's `.agents/`; use it to run multiple agents in parallel. `run` edits the project directory in place and also works without git; use it for non-git directories and single-subagent work. Run commands from the project root: the working tree you launch from is the project — a linked worktree keeps its own sessions, pi worktrees, and merge target — and pi-for-claude refuses to run from a non-ignored subdirectory of a checkout. A gitignored subdirectory counts as a standalone non-git project, so scratch dirs like `~/.claude-work/jobs/...` resolve as-is — but prefer an unsandboxed launch there (see the exception in step 2): the Claude sandbox matches real paths, so a scratch dir reached through a symlink (`~/.claude-work` resolves into `~/.agents/home/`) is usually not writable under its real path, and a sandboxed Monitor launch fails at startup with EPERM.

## Worktree workflow

1. Write the plan to `.agents/plans/<session>.md` in the git project directory. The plan basename becomes the session id, the branch `pi/<session>`, and the worktree `<project>/.agents/worktrees/<session>`, so pick a unique name — reusing an existing plan basename fails.

   Plan length should be proportional to the task; half as many tokens as the expected diff is a rough prior.

2. Launch the run in a plain persistent Monitor:

   ```js
   Monitor({ command: "pi-for-claude implement-in-worktree .agents/plans/<session>.md", description: "Pi session <session>", persistent: true, timeout_ms: 300000 })
   ```

   Exception: some sessions can't run inside the Claude sandbox, and Monitor is always sandboxed. Pi's locally-executing web tools (`agent_browser`, `fetch_content`) break there (provider-side `web_search` works sandboxed), and a project whose real path the sandbox can't write — such as a symlinked scratch dir like `~/.claude-work/jobs/...` — fails at startup with EPERM. Launch those sessions via unsandboxed background Bash (`nohup pi-for-claude run … &`), then attach a Monitor running `pi-for-claude watch <session>`, which follows the session's output and exits when the session settles.

3. Pi can call `consult_orchestrator(question)`, which writes `<session>.question.md` and blocks up to ten minutes for your response in `<session>.answer.md`. The Monitor emits the question and answer-file path. Restate both in a user reply — the user cannot see Monitor event bodies. `--no-consult` runs never ask.

4. While the subagent is running, redirect it with `steer`, `queue`, and `interrupt`.

5. When it completes, review the work: Pi finishes with everything committed on its private branch, and its commits and a diffstat against the project's branch are appended to the response. Check for errors, edge cases, subtle bugs, and deviations from your intent — GPT-5.6 can reward hack without mentioning it. Don't dirty the worktree while reviewing (`npm ci`, not `npm install`), and don't commit to files a live session is editing — queue changes into the session or hold them until after the merge. If `merge` refuses because the project checkout has uncommitted edits: `git stash`, merge, `git stash pop`.

6. Continue a closed session with `pi-for-claude resume <session> "<follow-up prompt>"` in a new persistent Monitor — same conversation and worktree.

7. Accept with `pi-for-claude merge <session>`: it rebases onto the project checkout's current branch, fast-forwards pi's commits onto it verbatim, and deletes the worktree and branch.

8. Discard with `pi-for-claude discard <session>` — never delete the worktree directory yourself. After merge or discard the session cannot be resumed; its logs remain under `.agents/sessions/`.

## In-place workflow

1. Write the plan to `.agents/plans/<session>.md` in the project directory. In a non-git project, run every command for the session from that directory.

2. Launch `pi-for-claude run .agents/plans/<session>.md` in a Monitor; steer, queue, or interrupt as usual.

3. When Pi finishes, the changes are shown with `git status` and `git diff` if the project directory is itself a git checkout; a standalone project (including a gitignored scratch dir inside some other repository) shows no git output. Use `resume` for follow-ups.

4. Close with `pi-for-claude discard <session>`: it removes only session metadata and leaves project files in place; without a worktree there is no `merge`.

## Command reference

- `implement-in-worktree <plan-file>` — implement a plan in a new worktree and session
- `run <plan-file>` — implement a plan directly in the project directory
- `resume <session> <follow-up>` — continue the same pi conversation in its worktree or project directory
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree
- `sessions` — list session ids, originating commands, and directories
- `result <session>` — print the last completed assistant response
- `view <session> [--no-open]` — export the conversation to HTML beside its JSONL and open it
- `watch <session>` — replay and follow a session's output; exits when the session settles, or exits 1 when it fails
- `steer <session> <message>` — deliver a message after the next tool call
- `queue <session> <message>` — queue a message until the current agent task finishes
- `interrupt <session>` — abort the active turn; the session remains resumable
- `merge <session>` — rebase, fast-forward the session's commits onto the project's branch, and clean up the worktree and branch
- `discard <session>` — force-remove the worktree and branch, or close a review or in-place session by removing its metadata record

Trailing flags on prompt commands (implement-in-worktree/run/resume/review):

- `--model <label-or-id>` — labels come from the pi-for-claude checkout's `models.json`: `default` is the latest openai-codex Sol model at medium, `best` the same at xhigh, `cheap` the latest Luna model at medium
- `--thinking <level>` — override the label's thinking level
- `--base <ref>` — diff base for reviews
- `--no-consult` — unattended run: removes the consult tool, so Pi makes conservative assumptions and reports them instead of blocking on questions
- `--prepend <file>` / `--append <file>` — attach text files to the prompt; paths resolve from the current directory

<!-- pi-scoped-models:start -->
## Pi scoped models

This list is generated from Pi's saved `/scoped-models` configuration.

- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-5.6-luna`
- `google/gemini-flash-latest`
<!-- pi-scoped-models:end -->
