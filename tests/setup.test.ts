import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const cli = join(import.meta.dirname, "../src/pi-for-claude.ts");
const packageHome = join(import.meta.dirname, "..");
const ignored = [".agents/sessions/", ".agents/plans/", ".agents/worktrees/"];

function machine() {
  const scratch = join(import.meta.dirname, "..", ".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pi-for-claude-setup-"));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(home);
  mkdirSync(agentDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: "",
    GIT_CONFIG_GLOBAL: join(home, "global-git-config"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_FOR_CLAUDE_HOME: packageHome,
  };
  const run = () => spawnSync(process.execPath, [cli, "setup"], { env, encoding: "utf8", cwd: root });
  return { root, home, agentDir, env, run };
}

function expectedSettings(agentDir: string) {
  const realAgentDir = realpathSync(agentDir);
  const auth = join(realAgentDir, "auth.json");
  return {
    sandbox: {
      filesystem: { allowWrite: [realAgentDir], allowRead: [auth] },
      network: { allowLocalBinding: true },
    },
    permissions: { deny: [`Read(${auth})`] },
  };
}

test("setup configures a fresh machine and is idempotent", () => {
  const { home, agentDir, run } = machine();
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Claude sandbox and auth policy: configured/);
  assert.match(first.stdout, /Provider login: not configured/);

  const settingsPath = join(home, ".claude", "settings.json");
  const claudePath = join(home, ".claude", "CLAUDE.md");
  const ignorePath = join(home, ".config", "git", "ignore");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), expectedSettings(agentDir));
  assert.equal(readFileSync(claudePath, "utf8"), `@${join(packageHome, "prompts", "pi-for-claude-instructions.md")}\n`);
  assert.deepEqual(readFileSync(ignorePath, "utf8").trim().split("\n"), ignored);

  const before = [settingsPath, claudePath, ignorePath].map((path) => readFileSync(path, "utf8"));
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Provider login: configured/);
  assert.match(second.stdout, /Claude sandbox and auth policy: already configured/);
  assert.match(second.stdout, /Claude instructions: already configured/);
  assert.match(second.stdout, /Global git ignore: already configured/);
  assert.deepEqual([settingsPath, claudePath, ignorePath].map((path) => readFileSync(path, "utf8")), before);
});

test("setup preserves existing settings and appends only missing lines with their line endings", () => {
  const { home, agentDir, run } = machine();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", sandbox: { filesystem: { allowWrite: ["existing"] } } }));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Global\r\n");
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  writeFileSync(join(home, ".config", "git", "ignore"), `.agents/sessions/\r\nlocal-only`);

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["existing", ...expectedSettings(agentDir).sandbox.filesystem.allowWrite]);
  assert.equal(settings.sandbox.network.allowLocalBinding, true);
  assert.match(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), /^# Global\r\n@.+\r\n$/);
  assert.equal(readFileSync(join(home, ".config", "git", "ignore"), "utf8"), `.agents/sessions/\r\nlocal-only\r\n.agents/plans/\r\n.agents/worktrees/\r\n`);
});

test("setup rejects unparseable settings before writing any setup files", () => {
  const { home, run } = machine();
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath, "{not json\n");

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot parse .*settings\.json/);
  assert.equal(readFileSync(settingsPath, "utf8"), "{not json\n");
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
  assert.equal(existsSync(join(home, ".config", "git", "ignore")), false);
});

test("setup keeps an existing instructions include when its install path differs", () => {
  const { home, run } = machine();
  const claudePath = join(home, ".claude", "CLAUDE.md");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudePath, "# Global\n@/old/install/prompts/pi-for-claude-instructions.md\n");

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already configured.*old\/install/);
  assert.equal(readFileSync(claudePath, "utf8"), "# Global\n@/old/install/prompts/pi-for-claude-instructions.md\n");
});

test("setup respects the configured global git excludes file", () => {
  const { root, home, run } = machine();
  const custom = join(root, "custom", "global-ignore");
  writeFileSync(join(home, "global-git-config"), `[core]\n\texcludesfile = ${custom}\n`);

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(custom, "utf8").trim().split("\n"), ignored);
  assert.equal(existsSync(join(home, ".config", "git", "ignore")), false);
});

test("setup reports missing sandbox dependencies after its other checks", { skip: process.platform !== "linux" }, () => {
  const machineState = machine();
  const bin = join(machineState.root, "bin");
  mkdirSync(bin);
  const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(git);
  symlinkSync(git, join(bin, "git"));
  machineState.env.PATH = bin;

  const result = machineState.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dependency error: ripgrep \(rg\) not found/);
  assert.match(result.stdout, /Provider login: not configured/);
  assert.match(result.stderr, /Pi's command sandbox is missing dependencies:.*ripgrep \(rg\) not found/);
});
