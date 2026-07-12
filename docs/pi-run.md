# pi-run

`pi-run` delegates implementation and review commands to pi. Worktree implementations stay isolated in persistent git worktrees; in-place implementations edit the project directory directly. Prompt files define model, thinking, sandbox, worktree, and session behavior; the runner owns git layout, RPC control, and session metadata.

## Setup

Run `npm install` in `~/.agents/pi-run`. Add the command directory to `PATH`:

```sh
export PATH="$PATH:$HOME/.agents/pi-run/bin"
```

`models.json` maps stable labels to provider/model ids. A label may be a string or an object with a default thinking level:

```json
{
  "default": "openai-codex/gpt-5.6-terra",
  "best": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }
}
```

Unknown labels, malformed config, and missing required settings fail before pi starts.

## Implementation workflow

Commands in a git project can run from any subdirectory or linked worktree; the runner resolves to the main checkout.

Write a uniquely named plan, then start a session:

```sh
pi-run implement-in-worktree path/to/fix-auth.md
```

The plan basename becomes the session id (`fix-auth`). The runner creates branch `pi/fix-auth` and worktree `<main>/.agents/worktrees/fix-auth`. Pi commits its work on the private branch and hands back a clean tree — a single commit preferred, multiple acceptable. If a run settles with a dirty tree, the runner sends the problem back to pi once; if it settles unclean again, the run completes with a warning appended to the output and the orchestrator takes over. A rebase left in progress never bounces: it is pi escalating a conflict it shouldn’t judge, and the run completes with a warning listing the conflicted files. Conflicts against main are otherwise not pi’s to resolve — they surface at merge time.

After the run:

1. Inspect the final response and worktree diff.
2. Run the project’s verification in the worktree.
3. Run `pi-run merge fix-auth`.

`merge` rebases the private session branch onto the main checkout’s current branch, fast-forwards main, then removes the worktree and branch. The session’s commits fast-forward onto main verbatim. Uncommitted changes in the worktree make merge fail — have pi commit them, or delete or gitignore stray files during review (ignored files never land and are deleted with the worktree; `<main>/.git/info/exclude` also works). Rebase is appropriate because session branches are private and unpushed; never rebase a shared branch.

If main moved, `merge` rebases and stops so verification can be rerun against the new base. Run `merge` again after verification. If rebase conflicts, the command reports the conflicted files and worktree and leaves the rebase in progress.

Resolve the merge, stage the changes, run `git rebase --continue`, rerun verification, then invoke `merge` again. The runner never chooses a conflict resolution.

Use `pi-run discard fix-auth` to explicitly delete an unwanted session worktree and branch. Discarding a review or in-place session removes only its metadata record. Either way the conversation JSONL and event log are kept, so `result` keeps working.

### In-place sessions

`pi-run run <plan-file>` edits the project directory directly without creating a branch or worktree, and it works without git. In a non-git project, run every pi-run command from the project root: the root is the resolved current directory, so a different directory cannot find the session and fails with `Unknown session`. Review in-place changes normally, then use `discard <session>` to close the session; there is no merge step and discard leaves project files in place.

## Commands

Prompt commands:

- `implement-in-worktree <plan-file>` — implement a plan in a new worktree and session.
- `run <plan-file>` — implement a plan directly in the project directory.
- `resume <session> <follow-up>` — continue the same pi conversation and worktree or project directory.
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree.
- `adversarial-review [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label.

Built-in commands do not call a model:

- `sessions` — list session ids, originating commands, and directories.
- `result <session>` — print the last completed assistant response.
- `steer <session> <message>` — deliver a message after the current tool calls and before the next model call.
- `queue <session> <message>` — queue work into the live run, taken up after the current agent run settles.
- `interrupt <session>` — abort the active turn; the session remains resumable.
- `watch <session>` — stream consult questions for a session; prints each question once with the answer-file path, exits when the session is merged or discarded.
- `merge <session>` — rebase, fast-forward the session’s commits onto main, and clean up.
- `discard <session>` — force-remove a worktree and branch, or just the record for review and in-place sessions.
- `help` — render prompt names, argument hints, and descriptions.

Prompt commands accept repeatable `--pre <file>` and `--post <file>` attachments plus `--model <label-or-id>`, `--thinking <level>`, and `--base <ref>`. Paths are resolved from the current directory. Model and thinking flags override prompt frontmatter.

## Sessions and control

Session JSONL, metadata, event logs, and control sockets live under `<main>/.agents/sessions`, resolved through git’s common directory so they survive linked-worktree removal. Outside git, `<main>` is the project root. Starting `implement-in-worktree` or `run` with an existing plan basename fails; use `resume` or rename the plan. Starting a prompt command against a session whose run is still active also fails — steer it, interrupt it, or wait for it to settle. A stale control socket left by a crashed run is cleaned up automatically.

During a live turn, pi can call `consult_orchestrator(question)`. The tool writes `<session>.question.md` beside the session log and waits up to ten minutes for `<session>.answer.md`. Write the answer file to unblock the turn. Both files are removed after the answer is read. A timeout tells pi to proceed with its best judgment and report the assumption.

When launching a run, start one Monitor running `pi-run watch <session>`. It lives as long as the session — covering the initial run and every resume — emits each question with the path to write the answer to, and exits when the session is merged or discarded. `watch` is scoped to one session so multiple orchestrators can share a repo without seeing each other's questions — only watch sessions you launched. Note that `watch` cannot distinguish an answered question from one that hit the consult timeout.

## Sandbox

`worktree-write` implementation runs allow writes only in the session worktree and temporary storage. `project-write` in-place runs allow writes in the project directory and temporary storage, but never grant git writes. `read-only` review runs allow temporary writes only. All modes:

- route every bash call to the sandbox extension’s OS-sandboxed implementation; pi registers the extension’s `bash` over its builtin tool, so the builtin bash never executes;
- explicitly allowlist tools in every mode so no unlisted tool is available; `bash` remains listed because pi applies allowlists to extension tools too;
- run hypa inside the bash sandbox, with write access only to `~/.hypa` for its SQLite store;
- cap each bash command at 600 seconds; a missing or zero timeout uses that cap;
- guard pi’s built-in read, write, edit, grep, find, and list tools;
- scope git writes for `worktree-write` to the session: pi can stage, commit, and rebase its own branch and append to `info/exclude`, while hooks, config (including `config.worktree`), other branches, the `commondir`/`gitdir` worktree pointers, and the worktree's `.git` file stay write-blocked;
- block all `.git` writes for `project-write`;
- block reads of configured secret and credential paths;
- limit network access from bash to the domains in `extensions/sandbox/sandbox.json`;
- fail closed: if OS sandbox initialization fails, bash remains blocked.

The pi process itself retains provider network access. Injection and `output-append` commands are trusted local configuration executed by the runner outside the pi sandbox. Project-external reads are allowed except for the explicit sensitive paths in the policy; this lets agents read shared SDKs and documentation while preventing common credential access.

The built-in file guard resolves the nearest existing ancestor before checking a new path, so writes through existing symlinks are checked against the symlink target. In-process path checks still have an unavoidable time-of-check/time-of-use gap. Bash is enforced by the operating system and does not share that limitation.

The sandbox extension is a fail-closed adaptation of the vetted `@sysid/pi-sandbox` design. Its interactive permission grants are deliberately omitted because RPC reports a UI even when no human is present; unknown writes and network destinations stay blocked. The OS enforcement uses the pinned `@sysid/sandbox-runtime-improved` version from that package.

## Prompt files

Commands are Markdown files under `prompts/`. `prompts/strings.json` holds every other piece of model-facing text — CLI errors, status lines, corrections, sandbox denial reasons — as a flat map of key to `$name`-placeholder template, rendered by the same substitution as prompt bodies; code never embeds model-facing text inline. Required frontmatter fields are `description`, `argument-hint`, `model`, `sandbox`, `worktree`, and `session`. `thinking` is optional when the selected model label supplies it. Optional `inject` entries run trusted shell commands in the target worktree; `output-append` runs after a completed turn. Template bodies support pi positional syntax (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, and `${@:N:L}`) plus named injected values.
