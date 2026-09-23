import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

import { piCli, renderString } from "./core.ts";

function msg(home: string, name: string, injections: Record<string, string> = {}): string {
  return renderString(join(home, "prompts", "strings.json"), name, injections);
}

function run(home: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: home, stdio: "inherit" });
  if (result.error) throw new Error(msg(home, "could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) throw new Error(msg(home, "update-command-failed", { command, status: String(result.status) }));
}

function output(home: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: home, encoding: "utf8" });
  if (result.error) throw new Error(msg(home, "could-not-run", { command, error: result.error.message }));
  if (result.status !== 0) throw new Error(msg(home, "update-command-failed", { command, status: String(result.status) }));
  return result.stdout.trim();
}

// Windows cannot spawn npm.cmd without a shell (CVE-2024-27980), and a shell re-splits arguments,
// so there npm runs as the JavaScript entry point that Windows installs keep beside npm.cmd.
function npm(home: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32") return ["npm", args];
  const cli = process.env.PATH?.split(delimiter).map((dir) => join(dir, "node_modules", "npm", "bin", "npm-cli.js")).find(existsSync);
  if (!cli) throw new Error(msg(home, "npm-not-found"));
  return [process.execPath, [cli, ...args]];
}

export function packageVersion(home: string): string {
  const metadata = JSON.parse(readFileSync(join(home, "package.json"), "utf8")) as Record<string, unknown>;
  if (metadata.name !== "pi-for-claude" || typeof metadata.version !== "string") throw new Error(msg(home, "package-metadata-invalid"));
  return metadata.version;
}

export function showVersion(home: string, executable: string): void {
  process.stdout.write(msg(home, "version-info", {
    version: packageVersion(home),
    revision: output(home, "git", ["-C", home, "rev-parse", "HEAD"]),
    executable: realpathSync(executable),
  }));
}

export function update(home: string): void {
  if (!existsSync(join(home, ".git"))) throw new Error(msg(home, "update-needs-checkout"));

  process.stdout.write(`${msg(home, "update-package")}\n`);
  run(home, "git", ["-C", home, "pull", "--ff-only"]);
  run(home, ...npm(home, ["install"]));

  process.stdout.write(`${msg(home, "update-extensions")}\n`);
  run(home, process.execPath, [piCli(join(home, "package.json")), "update", "--extensions"]);
}
