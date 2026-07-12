import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBlocked, writeBlocked } from "../extensions/sandbox/path-guard.ts";

const config = {
  denyRead: ["~/.agents/secrets.env", "~/.ssh"],
  allowWrite: ["."],
  denyWrite: [".env", ".git", "*.pem"],
  gitWrite: [],
};

test("write guard allows project files and blocks git metadata and secrets", () => {
  assert.equal(writeBlocked("src/app.ts", config, "/work/project", false), "");
  assert.match(writeBlocked(".git/index", config, "/work/project", false), /restricted .git metadata/);
  assert.match(writeBlocked("nested/.git/config", config, "/work/project", false), /restricted .git metadata/);
  assert.match(writeBlocked(".env", config, "/work/project", false), /restricted pattern/);
  assert.match(writeBlocked("/work/other/app.ts", config, "/work/project", false), /outside allowed paths/);
});

test("read-only guard blocks every write", () => {
  assert.match(writeBlocked("src/app.ts", config, "/work/project", true), /read-only/);
});

test("read guard blocks configured sensitive paths", () => {
  assert.match(readBlocked("~/.agents/secrets.env", config, "/work/project"), /restricted path/);
  assert.equal(readBlocked("README.md", config, "/work/project"), "");
});

test("gitWrite grants scoped git paths without opening the rest of .git", () => {
  const git = {
    ...config,
    denyWrite: [...config.denyWrite, "config.worktree", "commondir", "gitdir"],
    gitWrite: [
      "/main/.git/worktrees/fix-auth",
      "/main/.git/objects",
      "/main/.git/refs/heads/pi/fix-auth",
      "/main/.git/info/exclude",
    ],
  };
  const cwd = "/main/.agents/worktrees/fix-auth";
  assert.equal(writeBlocked("/main/.git/worktrees/fix-auth/index", git, cwd, false), "");
  assert.equal(writeBlocked("/main/.git/objects/ab/cdef", git, cwd, false), "");
  assert.equal(writeBlocked("/main/.git/refs/heads/pi/fix-auth", git, cwd, false), "");
  assert.equal(writeBlocked("/main/.git/info/exclude", git, cwd, false), "");
  assert.match(writeBlocked("/main/.git/config", git, cwd, false), /restricted .git metadata/);
  assert.match(writeBlocked("/main/.git/hooks/pre-commit", git, cwd, false), /restricted .git metadata/);
  assert.match(writeBlocked("/main/.git/refs/heads/main", git, cwd, false), /restricted .git metadata/);
  assert.match(writeBlocked("/main/.git/worktrees/fix-auth/config.worktree", git, cwd, false), /restricted pattern/);
  assert.match(writeBlocked("/main/.git/worktrees/fix-auth/commondir", git, cwd, false), /restricted pattern/);
  assert.match(writeBlocked(".git", git, cwd, false), /restricted pattern/);
});

test("write guard resolves an existing symlink before checking a new target", () => {
  const worktree = mkdtempSync(join(tmpdir(), "pi-run-guard-worktree-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-run-guard-outside-"));
  symlinkSync(outside, join(worktree, "escape"));
  assert.match(writeBlocked("escape/new.txt", { ...config, allowWrite: [worktree] }, worktree, false), /outside allowed paths/);
});
