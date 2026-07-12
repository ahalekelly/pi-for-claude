# pi-run build plan

Handoff doc for building `pi-run`: a deterministic delegation runner that sends implementation tasks, reviews, and other prompt-defined commands to GPT-5.6 (and later other models) via the `pi` coding agent, replacing `codex-task`. Designed 2026-07-11 in a working session; every "verified" claim below was tested live that day on pi 0.80.3.

## Context

- `codex-task` (wrapper around `codex exec` via a fork of openai/codex-plugin-cc, `~/Git/codex-plugin-cc`) is the current delegation tool. It stays installed and working as the escape hatch, and the build session should use it to delegate implementation work per Model Routing rules. Its doc lives at `~/Git/codex-plugin-cc/bin/codex-task.md` and is @-included by CLAUDE.md's "Codex Implementation Delegation" section; only after pi-run is confirmed working on real tasks does that include get replaced by pi-run's doc (see Deliverables).
- Why pi: native mid-task steering over RPC, caller-chosen session names, ChatGPT-subscription billing (openai-codex provider), provider-agnostic for future models, and no fork of a moving upstream to maintain.
- Agent config is version-controlled in a normal repo at `~/.agents` (`git -C "$HOME/.agents"`, alias `git-agent-cfg`). Home dotfiles like `~/.claude` and `~/.zshrc` live under `~/.agents/home/` with symlinks from `$HOME`. The `.gitignore` is a whitelist (`*`), so new files must be added explicitly with `git add -f`. `~/.agents/pi-run/` including this plan is committed there. Never add `secrets.env`.

## Verified facts (pi 0.80.3)

- `pi --model openai-codex/gpt-5.6-terra` works despite the stale model registry — unlisted ids pass through with a "Using custom model id" warning. Registry lists only up to gpt-5.5; check whether `pi update` fixes this.
- `-p` (non-interactive) prints only the final assistant message to stdout.
- `--session-id <arbitrary-string>` works ("fix-auth-flow" tested), creating `<timestamp>_<id>.jsonl` under `--session-dir`; an existing id is reused (= resume).
- RPC mode (`--mode rpc`, newline-framed JSON over stdio, docs at pi-mono `packages/coding-agent/docs/rpc.md`) has native `steer` (queued mid-run, delivered after the current turn's tool calls, before the next LLM call), `follow_up` (delivered after the agent finishes), `set_steering_mode`, and prompt-during-streaming. Read that doc in full before building; also check the abort/interrupt command and how turn completion is signaled.
- Pi has no sandboxing by default: bash runs with full user permissions, and the built-in read/write/edit/grep/find/ls tools run in-process via Node fs.
- Two candidate sandbox extensions both cover the built-in-tool gap; neither has been vetted or tested headless — evaluate both, this plan does not pre-decide:
  - `@sysid/pi-sandbox` (npm v1.1.1, fork of pi-mono's official example): OS bash sandbox via Anthropic's official @anthropic-ai/sandbox-runtime + a tool-guard layer on the built-in fs tools, fail-closed.
  - `pi-sandbox` (npm v0.4.3, `pi install npm:pi-sandbox`): read/write/edit controlled directly by allow/deny lists + bash via @carderne/sandbox-runtime (maintained fork of Anthropic's); blocked actions raise interactive allow-prompts — its headless/RPC behavior (hang, deny, or an event the runner could answer and route to the orchestrator) is the deciding question. Its example config self-describes as opening security loopholes; write a strict config from scratch regardless of choice.
  - Selection criteria: behavior of blocked actions under `-p`/RPC, expressiveness (.git deny-within-allow), source quality on vetting read. Fallback if both fail vetting: the official example extension + `--exclude-tools write,edit`.
- Pi's native prompt templates (docs/prompt-templates.md): frontmatter is only `description`/`argument-hint`; body supports `$1`, `$@`, `${1:-default}`, `${@:N}`. Our prompt files adopt this body syntax and a superset frontmatter; pi ignores unknown frontmatter keys, so the files remain valid pi templates.
- Pi auto-discovers AGENTS.md and CLAUDE.md in the project (`-nc` disables).

## Architecture

**Home**: `~/.agents/pi-run/` — TypeScript runner (Node 26 runs .ts natively, no build step, no deps if avoidable), `prompts/` (command definitions), `extensions/` (pi TS extensions: consult tool, vetted sandbox config), `docs/` (user-facing doc that CLAUDE.md @-includes). Symlink or PATH entry for the `pi-run` command.

**Commands are prompt files.** `pi-run <name> <project-dir> [args...]` dispatches to `prompts/<name>.md`. Unknown name → error listing available commands. `pi-run help` renders names + descriptions + argument-hints. Frontmatter schema (superset of pi's):

```markdown
---
description: Implement a plan in a fresh worktree
argument-hint: "<plan-file>"
model: default
thinking: high
sandbox: worktree-write        # worktree-write | read-only
worktree: create               # create | reuse | none
session: new                   # new | continue
inject:
  conflicts: git diff --name-only --diff-filter=U    # runs in the worktree, → $conflicts in body
output-append: |
  git status --short
  git diff --stat
---
Implement the plan below. It is also on disk at $plan_path if you need to re-read it later. When done, summarize what you did and anything you deviated from the plan on.

Do not run git commit or git push - the orchestrator reviews the diff and commits.

$plan
```

- **Model labels**: the frontmatter `model` field (and the `--model` flag) accepts either a literal id or a label defined in `~/.agents/pi-run/models.json`, e.g. `{"default": "openai-codex/gpt-5.6-terra", "best": "openai-codex/gpt-5.6-sol", "cheap": "openai-codex/gpt-5.6-luna"}`. Labels may optionally carry a default thinking level (`"best": {"model": "...", "thinking": "high"}`); frontmatter/flag thinking overrides it. Unknown label or missing config: fail loudly. New model generations then mean editing one config file, not every prompt.
- Injection commands and output-append commands are user-authored config: the runner executes them trusted (unsandboxed), in the worktree (or project dir when `worktree: none`).
- Prompt composition: template body with args substituted, plus repeatable `--pre <file>` / `--post <file>` flags that prepend/append file contents so the orchestrator can attach existing specs/issues/plans without rewriting them.
- v1 prompt commands: `run`, `resume` (body is just the follow-up args, `session: continue`, `worktree: reuse`), `resume-and-resolve-merge` (continue + reuse + injected conflicted-file list + resolution instructions preserving the thread's intent), `review`, `adversarial-review` (both `sandbox: read-only`, `worktree: none`, `model: best`, target = project dir by default: working tree or `--base <ref>`; optional session argument to review a session's worktree diff pre-merge instead). `run`/`resume` use `model: default`.
- Built-in verbs (no LLM): `merge`, `discard`, `result` (last assistant message from a session jsonl), `sessions` (list), `steer`, `followup`, `interrupt`, `help`.

**Sessions**: session id = plan file basename (e.g. `fix-auth.md` → `fix-auth`); the orchestrator always knows the handle, nothing is parsed back. `--session-dir <main-checkout>/.agents/scratchpad/pi/sessions`. `run` fails loudly if the session id already exists ("resume it or pick a new plan name"). Main-checkout resolution: `git rev-parse --path-format=absolute --git-common-dir`, strip `/.git` (same rule as codex-task) — scratchpad state always survives worktree removal.

**Worktrees**: `run` creates `<main-checkout>/.agents/scratchpad/worktrees/<session-id>` on branch `pi/<session-id>` from main HEAD. `resume`/`resume-and-resolve-merge` reuse it. Teardown only via `merge` (cleans worktree + branch after success) or `discard`. Never automatic — the orchestrator reviews the diff between run and merge.

**Merge / conflicts** (document all of this in the user-facing doc):
- Work arrives uncommitted (no-commit preamble). Orchestrator reviews the diff in the worktree, commits on the session branch, then `pi-run merge` rebases the session branch onto main inside the worktree and fast-forwards main.
- Prefer rebase over merge: session branches are private and unpushed, so rebase is always safe here; main stays linear. General rule: rebase private branches, never shared ones.
- On conflict the script stops and reports conflicted files + worktree path. It never resolves anything. Resolution is orchestrator work in the worktree (resolving-merge-conflicts skill); for tangled cases, `pi-run resume-and-resolve-merge <proj> <session>` hands resolution to the warm thread that wrote the changes.
- If main moved during the session, re-run verification after the rebase before fast-forwarding.

**RPC runner**: each run spawns a persistent `pi --mode rpc` child (session flags + model + extensions), sends the composed prompt, streams events to `<sessions-dir>/<id>.log`, prints the final message + output-append results to stdout on turn completion, then exits (the child exits with it; `resume` starts a new process on the same session). While a run is live, the runner listens on a control socket/FIFO at `<sessions-dir>/<id>.ctl`; `pi-run steer|followup|interrupt <proj> <session> "<text>"` connects and forwards the corresponding RPC command. Steering semantics come from pi, not us.

**Sandbox**: pick between the two candidate extensions (see Verified facts; vet the winner's source — it runs fully trusted), then configure: writes allowed only in the session worktree + whitelisted dirs (the pi session dir, $TMPDIR); reads per its policy (block sensitive patterns; consider whether project-external read restrictions are practical); network as needed for the provider. Verify it can block `.git` writes inside the worktree; note git's worktree metadata lives at `<main>/.git/worktrees/<name>/` — decide explicitly whether to whitelist it (lets `git add`/`stash` work) or leave it blocked as the hard commit-guard (index-writing git commands then fail loudly; reads like `git diff` still work). Wire via `-e` in the runner.

**Consult**: TS extension registering `consult_orchestrator(question: string)` — writes `<sessions-dir>/<id>.question.md`, block-polls for `<id>.answer.md` (delete both after reading; generous timeout ~10 min, on timeout return "orchestrator unavailable, proceed with your best judgment and flag the assumption"). The run/resume prompt templates include a line telling the model when to consult (mirror the subagent-consultation paragraph in AGENTS.md Model Routing). Orchestrator side: after launching a run, start a Monitor watching for `*.question.md` in the sessions dir.

## Deliverables

1. The runner, prompts, extensions, and sandbox config in `~/.agents/pi-run/`, on PATH.
2. `~/.agents/pi-run/docs/pi-run.md` — user-facing workflow doc (equivalent of the codex-task doc): the run→review→commit→merge workflow, command reference, flags, model labels, merge-conflict method, rebase policy, steering and consult usage.
3. Only after pi-run is confirmed working on real tasks (verification list below passed, plus at least one real delegated implementation reviewed and merged): replace CLAUDE.md's "Codex Implementation Delegation" section — currently `@~/Git/codex-plugin-cc/bin/codex-task.md` — with `@~/.agents/pi-run/docs/pi-run.md`. Until then codex-task remains the documented delegation path.
4. Commit `~/.agents/pi-run/` to the agent-config repo (`git -C "$HOME/.agents" add -f`); never add `secrets.env`.

## Verification (end-to-end, in a scratch git repo)

- `run` with a trivial plan: worktree + branch created, session jsonl in main-checkout scratchpad, final message + git summary on stdout, model warning shows terra.
- Sandbox: from inside a run, attempts to write outside the worktree, write `.git`, and read a blocked pattern all fail; bash and built-in write/edit are both covered.
- `steer` mid-run actually alters behavior mid-task (e.g. long task, steer to change target filename; confirm delivery before next LLM call via the event log).
- `consult`: prompt instructs the model to consult before acting; verify question file appears, answer unblocks it, answer is reflected in output.
- `resume` continues the thread with worktree intact; `run` with an existing session name fails loudly.
- `merge` happy path (commit → rebase → ff → cleanup); conflict path (move main under the session): script stops with correct file list, `resume-and-resolve-merge` resolves, merge completes.
- `review` on the project dir with `--base`; `interrupt` kills the turn cleanly and the session remains resumable.

## Open questions for the build session

- Full RPC protocol details: abort semantics, turn-completion signaling, whether extension tool calls surface as events (could replace the file-handshake consult someday).
- Sandbox extension choice (`@sysid/pi-sandbox` vs `pi-sandbox`), vetting outcome, and exact config shape; whether deny-within-allow (.git) is expressible; how `pi-sandbox`'s interactive allow-prompts behave under `-p`/RPC.
- Whether `pi update` refreshes the model registry (removes the custom-id warning); also clean up the stale `google/gemini-flash-latest` default-model warning in pi settings.
- Concurrent runs in one project: sessions dir is shared; worktrees isolate files, but check pi session-file locking if two runs ever share a session id (the fail-loud run collision check should prevent this).
- Whether `output-append` should also run on `result` (re-fetch) or only at run completion.
