# Live sandbox verification

Run this against a clean checkout of `pi-run` after `npm ci`. It uses a real pi session and provider, so it is intentionally not part of `npm test`.

```sh
cd /path/to/pi-run
scratch=$(mktemp -d /tmp/pi-run-sandbox-live.XXXXXX)
git -C "$scratch" init -b main
git -C "$scratch" config user.email sandbox@example.test
git -C "$scratch" config user.name "Sandbox verification"
printf '.agents/\n' > "$scratch/.gitignore"
printf 'sandbox verification\n' > "$scratch/README.md"
git -C "$scratch" add .gitignore README.md
git -C "$scratch" commit -m initial
cat > "$scratch/sandbox-live.md" <<'EOF'
Run these bash tool calls individually, in this order. Continue after expected failures and report each result.

1. `git status`
2. `touch "$HOME/pi-sandbox-escape-probe"` — this must fail because it is outside the worktree.
3. `curl --connect-timeout 5 https://example.com` — this must fail because example.com is not allowlisted.
4. `sleep 30` — this gives the operator time to inspect the running process.

Do not modify files or commit.
EOF
cd "$scratch"
PI_BIN=pi PI_RUN_HOME=/path/to/pi-run node /path/to/pi-run/src/pi-run.ts implement-in-worktree sandbox-live.md
```

While the final `sleep 30` runs, inspect it from another terminal:

```sh
ps -axo pid,ppid,command | grep -E '[s]leep 30|[b]ash -c'
test ! -e "$HOME/pi-sandbox-escape-probe"
```

Expected results:

- `git status` succeeds without being rewritten by a globally installed extension.
- The home-directory `touch` fails and `~/pi-sandbox-escape-probe` does not exist afterwards.
- The `curl` call fails because the sandbox network policy does not permit `example.com`.
- `sleep 30` runs without an unsandboxed `/bin/bash -c` child of pi. On macOS, `sandbox-exec` applies the Seatbelt policy and then execs into the command, so the wrapper does not remain visible in the process tree.

Remove the scratch repository with `trash "$scratch"` when finished. If the escape probe exists, remove it with `trash "$HOME/pi-sandbox-escape-probe"` after recording the failure.
