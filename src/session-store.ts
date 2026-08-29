import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { renderString } from "./core.ts";

const sessionIdPattern = /^[a-z0-9][a-z0-9-]*$/;

const mergeStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("unrebased") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("rebased"), onto: Type.String() }, { additionalProperties: false }),
]);

const sessionFields = {
  schemaVersion: Type.Literal(1),
  writerVersion: Type.String({ minLength: 1 }),
  command: Type.String(),
  mainCheckout: Type.String(),
  worktree: Type.String(),
  conversation: Type.String(),
  createdAt: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
};

const sessionSchema = Type.Union([
  Type.Object({
    ...sessionFields,
    kind: Type.Literal("worktree"),
    baseCommit: Type.String(),
    branch: Type.String(),
    mergeState: mergeStateSchema,
  }, { additionalProperties: false }),
  Type.Object({ ...sessionFields, kind: Type.Literal("in-place") }, { additionalProperties: false }),
  Type.Object({ ...sessionFields, kind: Type.Literal("review") }, { additionalProperties: false }),
]);

const turnFields = {
  id: Type.String({ pattern: "^[0-9a-f]{32}$" }),
  log: Type.String(),
  startedAt: Type.String(),
};

const turnSchema = Type.Union([
  Type.Object({ ...turnFields, state: Type.Literal("starting") }, { additionalProperties: false }),
  Type.Object({ ...turnFields, state: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object({ ...turnFields, state: Type.Literal("settled"), finishedAt: Type.String(), result: Type.String() }, { additionalProperties: false }),
  Type.Object({ ...turnFields, state: Type.Literal("failed"), finishedAt: Type.String(), error: Type.String() }, { additionalProperties: false }),
]);

type SessionRecord = Static<typeof sessionSchema>;
export type Session = SessionRecord & { id: string };
type NewRecord<Record> = Record extends SessionRecord
  ? Omit<Record, "schemaVersion" | "writerVersion" | "conversation" | "status"> & { id: string }
  : never;
export type NewSession = NewRecord<SessionRecord>;
export type Turn = Static<typeof turnSchema>;

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export class SessionStore {
  private readonly root: string;
  private readonly stringsHome: string;
  private readonly writerVersion: string;

  constructor(root: string, stringsHome: string, writerVersion: string) {
    this.root = root;
    this.stringsHome = stringsHome;
    this.writerVersion = writerVersion;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private msg(name: string, injections: Record<string, string> = {}): string {
    return renderString(join(this.stringsHome, "prompts", "strings.json"), name, injections);
  }

  private dir(id: string): string {
    if (!sessionIdPattern.test(id)) throw new Error(this.msg("unknown-session", { id }));
    return join(this.root, id);
  }

  private metadataPath(id: string): string {
    return join(this.dir(id), "session.json");
  }

  private turnPath(id: string): string {
    return join(this.dir(id), "turn.json");
  }

  private atomicWrite(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  exists(id: string): boolean {
    return sessionIdPattern.test(id) && existsSync(this.metadataPath(id));
  }

  read(id: string): Session {
    const path = this.metadataPath(id);
    if (!existsSync(path)) throw new Error(this.msg("unknown-session", { id }));
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1) {
      const actual = typeof value === "object" && value !== null && "schemaVersion" in value ? String(value.schemaVersion) : "unversioned";
      throw new Error(this.msg("incompatible-session-schema", { path, actual }));
    }
    if (!Check(sessionSchema, value)) throw new Error(this.msg("malformed-session-metadata", { path }));
    const record = value as SessionRecord;
    if (!validTimestamp(record.createdAt)
      || !isAbsolute(record.conversation)
      || resolve(dirname(record.conversation)) !== resolve(this.dir(id))
      || !basename(record.conversation).endsWith(".jsonl")) {
      throw new Error(this.msg("malformed-session-metadata", { path }));
    }
    return { ...record, id };
  }

  readActive(id: string): Session {
    const session = this.read(id);
    if (session.status !== "active") throw new Error(this.msg("session-closed", { id }));
    return session;
  }

  save(session: NewSession, conversation: string): Session {
    const { id, ...fields } = session;
    const record = { ...fields, schemaVersion: 1, writerVersion: this.writerVersion, conversation, status: "active" } as SessionRecord;
    this.atomicWrite(this.metadataPath(id), record);
    return { ...record, id };
  }

  update(session: Session): void {
    const { id, ...record } = session;
    this.atomicWrite(this.metadataPath(id), record);
  }

  close(session: Session): void {
    this.update({ ...session, status: "closed" });
  }

  list(): Session[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(this.metadataPath(entry.name)))
      .map((entry) => this.read(entry.name))
      .filter((session) => session.status === "active")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  beginTurn(id: string, turnId: string): TurnWriter {
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, "turn.lock");
    try {
      writeFileSync(lock, `${turnId}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(this.msg("session-currently-running", { id }));
      throw error;
    }
    try {
      const log = join(dir, `${turnId}.log`);
      writeFileSync(log, "", { mode: 0o600 });
      const turn: Turn = { id: turnId, state: "starting", log, startedAt: new Date().toISOString() };
      this.atomicWrite(this.turnPath(id), turn);
      return new TurnWriter(this.turnPath(id), lock, turn);
    } catch (error) {
      rmSync(lock);
      throw error;
    }
  }

  readTurn(id: string): Turn {
    const path = this.turnPath(id);
    if (!existsSync(path)) throw new Error(this.msg("session-has-no-turn", { id }));
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Check(turnSchema, value)) throw new Error(this.msg("malformed-turn-state", { path }));
    const turn = value as Turn;
    if (turn.log !== join(this.dir(id), `${turn.id}.log`)) throw new Error(this.msg("malformed-turn-state", { path }));
    return turn;
  }
}

export class TurnWriter {
  private readonly path: string;
  private readonly lock: string;
  private turn: Turn;

  constructor(path: string, lock: string, turn: Turn) {
    this.path = path;
    this.lock = lock;
    this.turn = turn;
  }

  private write(turn: Turn): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(turn, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.turn = turn;
  }

  append(text: string): void {
    appendFileSync(this.turn.log, text);
  }

  running(): void {
    this.write({ id: this.turn.id, state: "running", log: this.turn.log, startedAt: this.turn.startedAt });
  }

  settle(result: string): void {
    this.write({
      id: this.turn.id,
      state: "settled",
      log: this.turn.log,
      startedAt: this.turn.startedAt,
      finishedAt: new Date().toISOString(),
      result,
    });
    rmSync(this.lock);
  }

  fail(error: string): void {
    this.write({
      id: this.turn.id,
      state: "failed",
      log: this.turn.log,
      startedAt: this.turn.startedAt,
      finishedAt: new Date().toISOString(),
      error,
    });
    rmSync(this.lock);
  }
}
