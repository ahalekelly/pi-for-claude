# pi-for-claude

`pi-for-claude` allows Claude Code or other AI agents to delegate tasks to Pi agents. Pi is a minimalist, customizable agent harness that supports OpenAI Codex, Google Gemini, and many other models.

Features:

- Claude can provide steering instructions or interrupt Pi mid-task
- Pi can consult Claude when it needs guidance
- Resume Pi sessions with their full conversation context
- View Pi agent sessions live in your browser
- Isolated Git checkouts for Pi agents, with verified commit handoff and basic rebases
- Sandbox each run with scoped filesystem and network access
- Built-in web research and browser automation tools
- A simple format to save prompts and workflows. Separate model and sandbox settings for each saved prompt

Each Pi session shows up as a "monitor" in the Claude Code status bar.

Add a Markdown file with the prompt header to prompts/ to create a new pi-for-claude command.

## Setup

You must have Node.js 22.19 or newer.

Install from npm:

```sh
npm install --global pi-for-claude
```

Configure Claude Code's sandbox, check Pi's command-sandbox dependencies, and install the global instructions and git ignore:

```sh
pi-for-claude setup
```

`setup` generates the model-scoped instructions in Pi's user configuration; the installed package remains unchanged.

Then start Pi and log in to your model providers of choice.

Skill files are automatically loaded from the typical Pi locations:

```
~/.agents/skills/
~/.pi/agent/skills/
.agents/skills
.pi/skills/
```

Extensions installed in the user's normal system Pi configuration are not loaded.

Web research is provided by `pi-web-access`, using available Pi provider authentication or API keys such as `BRAVE_API_KEY`, `EXA_API_KEY`, or `OPENAI_API_KEY`.

Browser automation is provided by `pi-agent-browser-native`, which exposes the bundled `agent-browser` runtime through the native `agent_browser` Pi tool and keeps its browser state separate from the user's normal browser profile unless the agent specifies otherwise.

## Running Pi-for-Claude

Claude writes the task plan in a Markdown file, then passes it to `run`:

```sh
pi-for-claude run .agents/plans/fix-auth.md
```

Pi reads the plan file and edits the current project directly. From Claude Code, launch prompt commands with unsandboxed background Bash, then follow their output in a Monitor:

```js
Bash({ command: "nohup pi-for-claude run .agents/plans/fix-auth.md > /dev/null 2>&1 &", dangerouslyDisableSandbox: true })
Monitor({ command: "pi-for-claude watch fix-auth", description: "Pi session fix-auth", persistent: true, timeout_ms: 300000 })
```

Pi's command sandbox cannot start inside Claude Code's sandbox; Monitor is always sandboxed. The Monitor reports Pi's questions and answer-file paths.

`run` uses the `project-write` sandbox: Pi can edit project files, but it cannot write git metadata.

The task file basename becomes the session id: `fix-auth.md` creates session `fix-auth`. A unique filename must be used for each task session.

You can view the session in your browser:

```sh
pi-for-claude view fix-auth --live
```

To resume the same conversation when Pi needs another pass:

```sh
pi-for-claude resume fix-auth "Handle the failing edge-case test."
```

In a non-git project, the directory you run the commands in identifies the project and its sessions. In a git project, run commands from the checkout root: the checkout you run from is the project, so a linked worktree keeps its own sessions, plans, and private Pi checkouts, and `merge` fast-forwards its checked-out branch. pi-for-claude refuses to run from a subdirectory of a checkout, except one the checkout gitignores, which it treats as a standalone non-git project.

## Running in an isolated Git checkout

Use `implement-in-worktree` when you want to keep Pi's changes out of your current checkout or run several agents in parallel:

```sh
pi-for-claude implement-in-worktree .agents/plans/fix-auth.md
```

This command requires git. It creates a private local clone at `<project>/.agents/worktrees/fix-auth` and checks out branch `pi/fix-auth` there. Pi can edit the checkout and its private Git data, but it cannot write the project's Git data.

Inspect and verify the checkout, then merge it:

```sh
pi-for-claude merge fix-auth
```

`merge` rebases the private branch onto the branch the project has checked out, imports the verified commit, fast-forwards the project branch, and moves the private checkout to the trash. If the project branch moved in the meantime, `merge` stops after rebasing for re-verification; run it again to finish. If a rebase conflicts, pi-for-claude reports the files and leaves the rebase for Claude to resolve.

Discard unwanted work instead:

```sh
pi-for-claude discard fix-auth
```

The conversation remains available through `result` and `view` after a worktree is merged or discarded.

## Control a running session

These commands communicate with a live Pi run:

```sh
pi-for-claude steer fix-auth "Check the migration before changing the schema."
pi-for-claude queue fix-auth "Run the integration tests after this pass."
pi-for-claude interrupt fix-auth
```

`steer` adds a message after the next tool call. `queue` adds a message after the current task is done. `interrupt` stops the turn but keeps the session resumable.

Pi can call `consult_orchestrator` when it needs a decision. The running command prints the question and the answer-file path, then waits up to ten minutes for Claude to reply.

## Commands

Prompt commands call a model:

- `run <plan-file>` — implement a task in the current project
- `implement-in-worktree <plan-file>` — implement a task in a private Git checkout
- `resume <session> <follow-up>` — continue an implementation session
- `review [session] [focus] [--base <ref>]` — review the current project or a private session checkout without writing to it; the first argument is focus text unless it names an existing session

Built-in commands do not call a model:

- `setup` — configure the machine and check sandbox dependencies and provider login
- `update` — atomically install the latest complete pi-for-claude package, then update installed Pi extensions
- `version` — show the running package version, source revision, executable path, and latest published version
- `sessions` — list sessions and their working directories
- `result <session>` — print the persisted response from the last settled turn; reject a running or failed turn
- `view <session> [--live | --no-open]` — export the conversation to HTML and optionally keep it updated
- `watch <session>` — replay and follow the current turn's output; exits when that turn settles, or exits 1 when it fails
- `steer <session> <message>` — redirect a live turn
- `queue <session> <message>` — queue follow-up work
- `interrupt <session>` — stop a live turn
- `merge <session>` — integrate and close an isolated Git session
- `discard <session>` — close a session and, if present, move its private checkout to the trash
- `help` — list the available prompt commands

Prompt commands accept `--model <label-or-id>`, `--thinking <level>`, `--base <ref>`, `--no-consult` (unattended run: removes the consult tool and its guidance, so Pi makes conservative assumptions instead of blocking on questions), and repeatable `--prepend <file>` and `--append <file>` attachments.

## Model Selection

`models.json` gives provider/model ids stable labels. Every label requires a thinking level:

```json
{
  "default": {
    "model": "openai-codex/gpt-*-sol",
    "thinking": "medium"
  },
  "cheap": {
    "model": "openai-codex/gpt-*-luna",
    "thinking": "medium"
  }
}
```

A single `*` selects the registered model with the highest one- or two-part numeric version. The provider is part of the pattern, so `openai-codex/gpt-*-sol` never selects the corresponding `openai` model.

## Reusable Prompts

Markdown files under `prompts/` define reusable commands. Their header specifies the model, thinking level, sandbox, and session lifecycle; their body defines the main prompt sent to Pi. The ordered `input` list assembles Pi's message: `prompt` inserts the rendered Markdown body, `text` inserts literal text, and best-effort `shell` inserts command output. A failed input shell sends the same warning to Pi and Claude, then the run continues. The ordered `output` list controls what Claude sees: `pi` emits Pi's response, `text` emits literal text, and best-effort `shell` emits traced command output. Trusted shell entries run outside Pi's sandbox. The included commands are useful examples.

## Sandbox

Each prompt chooses one sandbox:

- `project-write` can edit the current project but cannot write git metadata
- `worktree-write` can edit and commit only inside its private session checkout
- `read-only` cannot edit the project

All modes block configured secret paths, restrict command network access to configured domains, and fail closed if the operating-system sandbox cannot start. `pi-for-claude setup` grants the wrapper write access to Pi's agent directory and local control-channel binding while denying Claude direct reads of the auth files. The Pi agent runtime retains access to its model provider.

The bundled web and browser tools make network requests directly from the agent runtime, outside the command network policy. `pi-web-access` rejects private and loopback fetch targets. `agent_browser` uses a tool-owned browser profile unless a task explicitly selects another profile.

Session data lives under `<project>/.agents/sessions/<session>`, where `<project>` is the checkout the command was launched from. `session.json` records the exact conversation path, `turn.json` records the current turn's state and final result, and each turn has its own log. The conversation and results remain after merge or discard.
