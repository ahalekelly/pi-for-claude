# pi-run

`pi-run` delegates implementation and review commands to pi while keeping each implementation isolated in a persistent git worktree. Prompt files define model, thinking, sandbox, worktree, and session behavior; the runner owns git layout, RPC control, and session metadata.

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

Commands run from inside the project — any subdirectory or linked worktree works; the runner resolves to the main checkout.

Write a uniquely named plan, then start a session:

```sh
pi-run run path/to/fix-auth.md
```

The plan basename becomes the session id (`fix-auth`). The runner creates branch `pi/fix-auth` and worktree `<main>/.agents/scratchpad/worktrees/fix-auth`. Pi leaves changes uncommitted and cannot write git metadata.

After the run:

1. Inspect the final response and worktree diff.
2. Run the project’s verification in the worktree.
3. Run `pi-run merge fix-auth "Fix the auth flow"`.

`merge` commits any uncommitted worktree changes, rebases the private session branch onto the main checkout’s current branch, squashes the whole session into a single commit with the given message, fast-forwards main, then removes the worktree and branch. Each merged session lands as exactly one commit on main, however many intermediate commits the session accumulated. Everything in the worktree that git doesn’t ignore is included — delete unwanted files during review, or keep them out via `.gitignore` or `<main>/.git/info/exclude` (ignored files never land and are deleted with the worktree). Rebase is appropriate because session branches are private and unpushed; never rebase a shared branch.

If main moved, `merge` rebases and stops so verification can be rerun against the new base. Run `merge` again after verification. If rebase conflicts, the command reports the conflicted files and worktree and leaves the rebase in progress. Resolve them there, or use:

```sh
pi-run resume-and-resolve-merge fix-auth "Preserve both validation rules"
```

Review the resolved files, stage them, run `git rebase --continue`, rerun verification, then invoke `merge` again. The runner never chooses a conflict resolution.

Use `pi-run discard fix-auth` to explicitly delete an unwanted session worktree and branch. Discarding a review session removes only its metadata record. Either way the conversation JSONL and event log are kept, so `result` keeps working.

## Commands

Prompt commands:

- `run <plan-file>` — implement a plan in a new worktree and session.
- `resume <session> <follow-up>` — continue the same pi conversation and worktree.
- `resume-and-resolve-merge <session> [instructions]` — continue the session with the active conflict list injected.
- `review [session] [focus] [--base <ref>]` — read-only review of the project or a session worktree.
- `adversarial-review [session] [focus] [--base <ref>]` — read-only challenge review using the `best` model label.

Built-in commands do not call a model:

- `sessions` — list session ids, originating commands, and worktrees.
- `result <session>` — print the last completed assistant response.
- `steer <session> <message>` — deliver a message after the current tool calls and before the next model call.
- `queue <session> <message>` — queue work into the live run, taken up after the current agent run settles.
- `interrupt <session>` — abort the active turn; the session remains resumable.
- `watch <session>` — stream consult questions for a session; prints each question once with the answer-file path, exits when the run ends.
- `merge <session> <message>` — squash the session into one commit on main and clean up.
- `discard <session>` — force-remove the worktree and branch, or just the record for review sessions.
- `help` — render prompt names, argument hints, and descriptions.

Prompt commands accept repeatable `--pre <file>` and `--post <file>` attachments plus `--model <label-or-id>`, `--thinking <level>`, and `--base <ref>`. Paths are resolved from the current directory. Model and thinking flags override prompt frontmatter.

## Sessions and control

Session JSONL, metadata, event logs, and control sockets live under `<main>/.agents/scratchpad/pi/sessions`, resolved through git’s common directory so they survive linked-worktree removal. Starting a `run` with an existing plan basename fails; use `resume` or rename the plan. Starting a prompt command against a session whose run is still active also fails — steer it, interrupt it, or wait for it to settle. A stale control socket left by a crashed run is cleaned up automatically.

During a live turn, pi can call `consult_orchestrator(question)`. The tool writes `<session>.question.md` beside the session log and waits up to ten minutes for `<session>.answer.md`. Write the answer file to unblock the turn. Both files are removed after the answer is read. A timeout tells pi to proceed with its best judgment and report the assumption.

After launching each run or resume, start a Monitor running `pi-run watch <session>`. It emits each question with the path to write the answer to, and exits when the session's run ends. `watch` is scoped to one session so multiple orchestrators can share a repo without seeing each other's questions — only watch sessions you launched. Note that `watch` cannot distinguish an answered question from one that hit the consult timeout.

## Sandbox

Implementation runs allow writes only in the session worktree and temporary storage. Review runs allow temporary writes only. Both modes:

- wrap bash with the OS sandbox;
- guard pi’s built-in read, write, edit, grep, find, and list tools;
- block all `.git` writes, so pi cannot stage, commit, stash, or change repository configuration;
- block reads of configured secret and credential paths;
- limit network access from bash to the domains in `extensions/sandbox/sandbox.json`;
- fail closed: if OS sandbox initialization fails, bash remains blocked.

The pi process itself retains provider network access. Injection and `output-append` commands are trusted local configuration executed by the runner outside the pi sandbox. Project-external reads are allowed except for the explicit sensitive paths in the policy; this lets agents read shared SDKs and documentation while preventing common credential access.

The built-in file guard resolves the nearest existing ancestor before checking a new path, so writes through existing symlinks are checked against the symlink target. In-process path checks still have an unavoidable time-of-check/time-of-use gap. Bash is enforced by the operating system and does not share that limitation.

The sandbox extension is a fail-closed adaptation of the vetted `@sysid/pi-sandbox` design. Its interactive permission grants are deliberately omitted because RPC reports a UI even when no human is present; unknown writes and network destinations stay blocked. The OS enforcement uses the pinned `@sysid/sandbox-runtime-improved` version from that package.

## Prompt files

Commands are Markdown files under `prompts/`. Required frontmatter fields are `description`, `argument-hint`, `model`, `sandbox`, `worktree`, and `session`. `thinking` is optional when the selected model label supplies it. Optional `inject` entries run trusted shell commands in the target worktree; `output-append` runs after a completed turn. Template bodies support pi positional syntax (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, and `${@:N:L}`) plus named injected values.
