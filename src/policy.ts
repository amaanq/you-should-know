import { sameTopic } from "./parse.ts";
import type { State } from "./state.ts";

export const TOPICS_KEPT = 50;
export const CLEAR_AFTER_PROMPTS = 2;

export const checkEvery = (raw: string | undefined): number => {
  const every = Number(raw);
  return Number.isSafeInteger(every) && every > 0 ? every : 6;
};

export const isCheckStep = (index: number, every: number) => index > 0 && index % every === 0;

const remember = (list: readonly string[], line: string) =>
  [...list.filter((item) => !sameTopic(item, line)), line].slice(-TOPICS_KEPT);

export const isRepeat = (state: State, line: string) =>
  [...state.seen, ...state.known].some((item) => sameTopic(item, line));

export function markSeen(state: State, line: string): void {
  state.seen = remember(state.seen, line);
}

export function markKnown(state: State, line: string): void {
  state.known = remember(state.known, line);
}

// The builtin's curve, the third unanswered offer in a row skips 1 check and each
// further one doubles that up to 16.
export function noteIgnored(state: State): void {
  state.ignoredInARow += 1;
  const over = state.ignoredInARow - 2;
  state.skipsLeft = over <= 0 ? 0 : Math.min(16, 2 ** (over - 1));
}

export function noteAnswered(state: State): void {
  state.ignoredInARow = 0;
  state.skipsLeft = 0;
}

export function takeSkip(state: State): boolean {
  if (state.skipsLeft <= 0) return false;
  state.skipsLeft -= 1;
  return true;
}
