import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseState, serializeState, type State } from "./state.ts";

const LOCK_STALE_MS = 5 * 60 * 1000;

export const stateDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "you-should-know");

const statePath = () => join(stateDir(), "state.json");

export async function readState(): Promise<State> {
  return parseState(await readFile(statePath(), "utf8").catch(() => undefined));
}

let writes: Promise<unknown> = Promise.resolve();

// Serialized within a process, unlocked across processes. Two harnesses racing can
// drop one update, and everything kept here is advisory enough to accept that.
export function updateState<T>(change: (state: State) => T): Promise<T> {
  const next = writes.then(() => writeState(change));
  writes = next.catch(() => undefined);
  return next;
}

async function writeState<T>(change: (state: State) => T): Promise<T> {
  const state = await readState();
  const result = change(state);

  await mkdir(stateDir(), { recursive: true });
  const temp = `${statePath()}.${crypto.randomUUID()}`;
  await writeFile(temp, serializeState(state));
  await rename(temp, statePath());
  return result;
}

// One check in flight per session, across processes. A lock older than any
// side call can take is left over from a crash and gets taken over.
export async function withCheckLock(id: string, run: () => Promise<void>): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  const path = join(stateDir(), `${id.replace(/[^\w.-]/g, "_")}.lock`);

  try {
    if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) await rm(path, { force: true });
  } catch {}

  let handle;
  try {
    handle = await open(path, "wx");
  } catch {
    return;
  }

  try {
    await run();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}

export async function debugLog(entry: Record<string, unknown>): Promise<void> {
  if (!process.env.YSK_DEBUG) return;
  await mkdir(stateDir(), { recursive: true });
  await writeFile(join(stateDir(), "debug.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
    flag: "a",
  });
}
