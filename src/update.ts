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
  // Pi's packages move to their latest releases once they are an hour old, past npm's release-age quarantine.
  // The hour matters because npm lists a release minutes before its tarball downloads, so the newest release can 404.
  const metadata = JSON.parse(readFileSync(join(home, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const releases = Object.keys(metadata.dependencies).filter((name) => name.startsWith("@earendil-works/")).map((name) => {
    const view = JSON.parse(output(home, ...npm(home, ["view", name, "dist-tags.latest", "time", "--json"]))) as { "dist-tags.latest": string; time: Record<string, string> };
    const version = view["dist-tags.latest"];
    const published = view.time[version];
    if (!published) throw new Error(msg(home, "release-time-missing", { release: `${name}@${version}` }));
    return { spec: `${name}@${version}`, settled: Date.now() - Date.parse(published) > 60 * 60 * 1000 };
  });
  const fresh = releases.filter((release) => !release.settled).map((release) => release.spec);
  if (fresh.length > 0) process.stdout.write(`${msg(home, "update-release-too-new", { releases: fresh.join(", ") })}\n`);
  else run(home, ...npm(home, ["install", "--min-release-age=0", ...releases.map((release) => release.spec)]));

  process.stdout.write(`${msg(home, "update-extensions")}\n`);
  run(home, process.execPath, [piCli(join(home, "package.json")), "update", "--extensions"]);
}
