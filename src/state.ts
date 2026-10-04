import type { Tag } from "./parse.ts";

export interface Offer {
  tag: Tag;
  line: string;
  explanation: string;
  shownAt: number;
  promptsSurvived: number;
  explained: boolean;
}

export interface SessionState {
  turnId?: string;
  step: number;
  off: boolean;
  offer?: Offer;
  touchedAt: number;
}

export interface State {
  seen: string[];
  known: string[];
  ignoredInARow: number;
  skipsLeft: number;
  sessions: Record<string, SessionState>;
  pendingForks: PendingFork[];
}

export interface PendingFork {
  id: string;
  pid: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function parseState(text: string | undefined): State {
  let raw: Record<string, unknown> = {};

  try {
    if (text !== undefined) raw = JSON.parse(text);
  } catch {}

  const sessions = typeof raw.sessions === "object" && raw.sessions !== null ? raw.sessions : {};

  return {
    seen: strings(raw.seen),
    known: strings(raw.known),
    ignoredInARow: count(raw.ignoredInARow),
    skipsLeft: count(raw.skipsLeft),
    sessions: sessions as Record<string, SessionState>,
    pendingForks: Array.isArray(raw.pendingForks)
      ? raw.pendingForks.filter(
          (fork): fork is PendingFork => typeof fork?.id === "string" && typeof fork?.pid === "number",
        )
      : [],
  };
}

export function serializeState(state: State): string {
  const cutoff = Date.now() - SESSION_TTL_MS;

  for (const [id, session] of Object.entries(state.sessions)) {
    if (session.touchedAt < cutoff) delete state.sessions[id];
  }

  return JSON.stringify(state, null, 2);
}

export function session(state: State, id: string): SessionState {
  const existing = state.sessions[id] ?? { step: 0, off: false, touchedAt: 0 };
  existing.touchedAt = Date.now();
  state.sessions[id] = existing;
  return existing;
}
