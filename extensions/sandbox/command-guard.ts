import { parse, type ParseEntry } from "shell-quote";

const operators = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")", "<("]);
const wrappers = new Set(["command", "builtin", "exec", "env", "nice", "nohup", "stdbuf", "sudo", "time", "timeout", "watch"]);
const shells = new Set(["bash", "sh", "zsh"]);
const commandPrefixes = new Set(["!", "do", "elif", "else", "if", "then", "until", "while", "{"]);

function executableName(word: string): string {
  return word.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, "").toLowerCase();
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function segmentUsesRm(words: string[]): boolean {
  const commandIndex = words.findIndex((word) => !isAssignment(word) && !commandPrefixes.has(word));
  if (commandIndex === -1) return false;
  const command = executableName(words[commandIndex]!);
  if (command === "rm") return true;
  if (wrappers.has(command)) return words.slice(commandIndex + 1).some((word) => executableName(word) === "rm");
  if (command === "xargs") return words.slice(commandIndex + 1).some((word) => executableName(word) === "rm");
  if (command === "find") {
    return words.some((word, index) => ["-exec", "-execdir"].includes(word) && words.slice(index + 1).some((entry) => executableName(entry) === "rm"));
  }
  if (shells.has(command)) {
    const scriptIndex = words.findIndex((word, index) => index > commandIndex && word === "-c") + 1;
    return scriptIndex > 0 && scriptIndex < words.length && usesRm(words[scriptIndex]!);
  }
  return false;
}

export function usesRm(command: string): boolean {
  const entries = parse(command.replaceAll("\n", ";"));
  let segment: string[] = [];
  for (const entry of [...entries, { op: ";" } satisfies ParseEntry]) {
    if (typeof entry === "string") {
      segment.push(entry);
      continue;
    }
    if (!("op" in entry) || !operators.has(entry.op)) continue;
    if (segmentUsesRm(segment)) return true;
    segment = [];
  }
  return false;
}
