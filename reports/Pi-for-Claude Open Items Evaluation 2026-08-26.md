# Pi-for-Claude Open Items Evaluation — 2026-08-26 00:55 PDT

## Scope

This review covers every item open in `ahalekelly/pi-for-claude` at 2026-08-26 00:55 PDT: three issues ([#11](https://github.com/ahalekelly/pi-for-claude/issues/11), [#12](https://github.com/ahalekelly/pi-for-claude/issues/12), [#14](https://github.com/ahalekelly/pi-for-claude/issues/14)) and one pull request ([#13](https://github.com/ahalekelly/pi-for-claude/pull/13)). I inspected every discussion and diff, current `main` at [`887456d`](https://github.com/ahalekelly/pi-for-claude/commit/887456dc1de0400fa84f16d068d82d7cc0c02f91), relevant source and tests, both closed issues ([#9](https://github.com/ahalekelly/pi-for-claude/issues/9), [#10](https://github.com/ahalekelly/pi-for-claude/issues/10)), and all eight closed PRs ([#1](https://github.com/ahalekelly/pi-for-claude/pull/1)–[#8](https://github.com/ahalekelly/pi-for-claude/pull/8)). Sources are GitHub, repository code, tagged dependency code, and a local reproduction; no secondary accounts are used.

## Conclusions

| Items | Underlying problem | Recommendation |
| --- | --- | --- |
| [#11](https://github.com/ahalekelly/pi-for-claude/issues/11), [#14](https://github.com/ahalekelly/pi-for-claude/issues/14) | Session identity, turn state, live output, and final results are inferred from unrelated files and stale content. | Replace the flat artifact helpers with one session module that owns exact paths and an explicit per-turn lifecycle. |
| [#12](https://github.com/ahalekelly/pi-for-claude/issues/12) | A sandboxed Git process writes shared repository internals through a policy that assumes macOS patterns and Linux bind mounts mean the same thing. The bash adapter also omits sandbox-runtime's required post-command cleanup. | Give each session private Git metadata and objects; keep the project repository read-only until the host imports a verified commit. Call sandbox cleanup after every child. |
| [#13](https://github.com/ahalekelly/pi-for-claude/pull/13) | A mutable, outdated npm-linked submodule kept producing an obsolete metadata format after the format had been retired. | Close the PR. Fix atomic installation, update propagation, and version visibility instead of permanently recognizing one obsolete filename shape. |

## #11 and #14: make session state authoritative

### Evidence

One cumulative `<id>.log` serves every run and resume: the launcher opens it in append mode, then writes the terminal marker after `runPrompt` returns ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L660-L664), [source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L952-L955)). `watch` replays that whole file and treats a terminal text suffix plus absence of `<id>.ctl` as settled ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L881-L917)). A resumed process does not create its control file until after argument handling, sandbox preflight, SDK loading, model setup, resource loading, and session opening ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L573-L605), [source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L420-L426)). During that gap, the prior turn's terminal suffix looks current. This directly explains #11.

The empty stdout is also structural. The SDK subscriber stores the last complete response in memory but emits no streaming deltas; `runPrompt` prints the result only after `sdkRun` has settled ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L372-L390), [source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L664-L674)). The documented unsandboxed-launch/`watch` workflow therefore has no live model output despite `watch` being the only attached interface. Closed [#10](https://github.com/ahalekelly/pi-for-claude/issues/10#issuecomment-5407115337) made that workflow the default, increasing the impact.

`result`, resume, and view repeatedly rediscover the Pi conversation by scanning the sessions directory for a filename ending in `_<id>.jsonl`; `result` then reads, splits, and parses the entire file in reverse ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L125-L146), [source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L348-L350), [source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/pi-for-claude.ts#L596-L605)). The #14 conversation was 14 MB, so this is expensive as well as ambiguous.

#14's proposed rename or stale-directory explanation is not supported by the Pi implementation. `SessionManager` chooses one path, appends entries, and only truncates that same path when rewriting migrations; it does not rename the live conversation during shutdown ([Pi v0.84.1 source](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/session-manager.ts#L953-L1039)). A retry or sleep would conceal an unexplained race while preserving directory discovery as a second source of truth.

The marker design predates resume-safe lifecycle semantics. It began in [`473f04a`](https://github.com/ahalekelly/pi-for-claude/commit/473f04aa4e3288463c0ca95a422daeecf9d070fc); merged [PR #7](https://github.com/ahalekelly/pi-for-claude/pull/7) added a failure marker after a healthy JSONL and launcher state disagreed, but kept terminal prose and `.ctl` as the state model. [PR #6](https://github.com/ahalekelly/pi-for-claude/pull/6) records another settle/teardown ordering failure. These are repeated evidence that lifecycle needs an owner.

### End-state design

Create a session module that owns a directory and exact paths for each ID. Its durable metadata records the exact Pi JSONL path when `SessionManager` is created; no command scans filenames. Each run or resume gets a unique turn ID, invocation-specific event log, and typed state:

1. Before any fallible preflight or SDK startup, atomically publish `active` with the turn ID and log path.
2. Append structured live events from SDK text deltas, tool activity, questions, and wrapper output to that turn's log.
3. After Pi persistence and extension shutdown complete, atomically replace `active` with either `settled` and the final result or `failed` and the failure. The control file only locates the control server; it never decides lifecycle.
4. `watch` binds to one turn ID and exits only on that turn's typed terminal state. It cannot match a prior turn's suffix.
5. `result` fails clearly while a turn is active. After settle it reads the small persisted terminal result, not a mutable 14 MB conversation.

Keep the Pi JSONL as conversation history for resume and view. Keep wrapper lifecycle and result state in the wrapper-owned session record. This separates two distinct responsibilities without duplicating inferred state.

### Acceptance tests

- Start `watch` during a deliberately delayed resume preflight; it must bind to the new turn and never exit on the preceding turn's terminal state.
- Resume the same session repeatedly; each watcher must show only the selected invocation's live events and terminal outcome.
- Assert that a text delta reaches `watch` before the model finishes while launcher stdout and the persisted final result remain coherent.
- Call `result` during an active turn and require a loud active-state error; after settle, require the exact persisted response without reading the conversation file.
- Resume and view through the metadata's exact conversation path with unrelated JSONLs in the directory; no suffix scan may occur.
- Fail each startup stage and verify that the published turn becomes `failed`, not permanently `active`.

## #12: move Git's write boundary

### Evidence

`gitPolicyPaths` grants the linked worktree Git directory, shared objects, the session branch ref and hypothetical lock file, its reflog and lock, and `info/exclude` ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/extensions/sandbox/index.ts#L24-L55)). The same list is passed both to sandbox-runtime's OS policy and the in-process file-tool guard ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/extensions/sandbox/index.ts#L115-L133)). The guard understands path containment ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/extensions/sandbox/path-guard.ts#L48-L56)); Linux bwrap instead skips non-existent `allowWrite` bind sources ([sandbox-runtime v0.0.67 source](https://github.com/anthropic-experimental/sandbox-runtime/blob/v0.0.67/src/sandbox/linux-sandbox-utils.ts#L931-L950)). Git must create ref locks atomically, so an individual not-yet-existing `.lock` cannot become writable this way.

Granting `refs/heads/pi/` and `logs/refs/heads/pi/` is not a sound fix. It would let sandboxed shell commands rewrite sibling sessions, while `packed-refs.lock` remains at the shared common-Git-dir root. #12 already records a `packed-refs.lock` failure ([discussion](https://github.com/ahalekelly/pi-for-claude/issues/12#issuecomment-5417123325)). A disposable `strace` during this review also showed that even a normal commit on a detached linked worktree opens the common `.git/packed-refs.lock`; detaching does not remove the shared-write requirement.

The dirty-handback symptom has a separate, exact cause. On Linux, sandbox-runtime creates host mount-point placeholders for non-existent deny paths and exposes `SandboxManager.cleanupAfterCommand()` to remove them after each child ([sandbox-runtime source](https://github.com/anthropic-experimental/sandbox-runtime/blob/v0.0.67/src/sandbox/linux-sandbox-utils.ts#L389-L480), [sandbox-runtime source](https://github.com/anthropic-experimental/sandbox-runtime/blob/v0.0.67/src/sandbox/sandbox-manager.ts#L1733-L1750)). Pi-for-Claude's custom bash adapter wraps and spawns the child but never calls that cleanup method ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/extensions/sandbox/index.ts#L80-L110)). The focused Linux test reproduces `AD .bashrc`, `.env`, `.gitconfig`, `commondir`, `config.worktree`, `gitdir`, and other placeholders. The full current suite is 67/68; the sole failure is `tests/runner.test.ts:925`.

### End-state design

Give every worktree session an isolated local checkout with a private Git directory: private refs, reflogs, index, locks, packed refs, and object store. Seed it from the project's exact base commit, but expose the project checkout and its Git directory read-only. The sandbox can grant the complete private Git namespace because no sibling session or project ref lives there.

At acceptance, the host imports one exact candidate commit from the private repository, verifies its ancestry, tree, clean handback, and expected base, then fast-forwards the project. Host integration must not execute config or hooks supplied by the session repository. If the project moved, update and rebase inside the isolated repository, then verify the resulting commit before import.

Separately, call `SandboxManager.cleanupAfterCommand()` in a `finally` path after every sandboxed child closes, errors, aborts, or times out, and before resolving the tool call. Do not hide placeholders from `git status`; they must be gone before handback inspection.

### Acceptance tests

- Commit and rebase in live Linux bwrap sessions for a normal checkout, linked worktree, and submodule. No write under the project's common Git directory may occur before host acceptance.
- Run two sessions in parallel and attempt direct writes to the other session's Git state and the project Git state; both must fail.
- Pack the project's refs before launch and verify that commit, rebase, merge, and discard need no project `packed-refs.lock` access.
- Verify the exact imported commit and tree before fast-forwarding the project; reject moved bases and dirty handbacks.
- Exercise success, child spawn error, nonzero exit, timeout, and abort in the bash adapter; every case must remove sandbox mount placeholders before the promise settles.
- Keep the existing unclean-handback test unchanged and make it pass. Filtering `AD` paths is not acceptable.

## PR #13: close it and fix deployment

[PR #13](https://github.com/ahalekelly/pi-for-claude/pull/13) adds a special error string, branch, and regression test for pre-`fbb5d7a` metadata filenames ([diff](https://github.com/ahalekelly/pi-for-claude/pull/13/files)). It does not restore compatibility, but it permanently teaches current code to recognize one obsolete deployment artifact.

The repository already made this decision in [#9](https://github.com/ahalekelly/pi-for-claude/issues/9): rename live records or trash finished ones, fail the listing rather than return partial state, and close the issue after the 35 known records were cleaned ([closing comment](https://github.com/ahalekelly/pi-for-claude/issues/9#issuecomment-5285552022)). #13 recurred because an npm-linked mutable submodule stayed on the old writer for 12 days, not because current filename validation lacks precision ([PR description](https://github.com/ahalekelly/pi-for-claude/pull/13)). Encoding the symptom creates a growing catalog of stale-writer shapes.

This is part of a broader deployment boundary problem. The executable runs directly from mutable TypeScript source ([commit](https://github.com/ahalekelly/pi-for-claude/commit/2b7e96db942be5629330503726d416c4e0af3d80)); closed-unmerged [PR #8](https://github.com/ahalekelly/pi-for-claude/pull/8) records a merge making new source live before `npm install` supplied its dependency. The current `update` command updates bundled dependencies, not Pi-for-Claude itself ([source](https://github.com/ahalekelly/pi-for-claude/blob/887456dc1de0400fa84f16d068d82d7cc0c02f91/src/update.ts#L6-L32)).

Install complete, immutable versions. Stage source/build output and its dependency tree, verify it, then atomically switch the command to the new version. Never point the global executable at a checkout while a merge, submodule update, or dependency install can change it in place. Make the running package version, source revision, executable realpath, and available update visible in one diagnostic command. Stamp new durable session metadata with its writer/schema version and fail clearly on incompatible state; do not load, migrate, or pattern-match obsolete formats.

Deployment acceptance tests should kill an update before the atomic switch and prove the old command still works, then complete it and prove source, dependencies, and reported revision switch together. A machine on an outdated version must expose that fact before it creates new session state.

## Recommended order

1. Close PR #13; retain #9's manual rename/trash remedy for any remaining obsolete record.
2. Restore the sandbox adapter contract by calling `cleanupAfterCommand`; this removes the current test contaminant and gives later work a trustworthy handback check.
3. Build the authoritative session module and close #11 and #14 together.
4. Replace shared linked-worktree Git writes with isolated per-session Git state, then close #12.
5. Ship these changes only through the atomic immutable installation path, with visible version/update state.
