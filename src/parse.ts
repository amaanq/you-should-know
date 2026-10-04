export type Tag = "You should know" | "Heads up";

export type Proposal =
  { kind: "none" } | { kind: "unparsable" } | { kind: "line"; line: string; tag: Tag; explanation?: string };

export type Reply =
  Exclude<Proposal, { kind: "line" }> | (Extract<Proposal, { kind: "line" }> & { explanation: string });

export interface Card {
  title: string;
  lead: string;
  sketch: string[];
  caption: string;
}

const MAX_LINE = 240;
const LEARN = /^learn\s*:\s*/i;
const EXPLAIN = /^explain:\s*/i;
const BULLET = /^[-*•]\s+/;
const HEADS_UP = /^\W*heads[\s-]*up\W*$/i;
const INLINE_TAG = /[.\s—–-]*\s\**tag\**\s*:\s*\**\s*(heads[\s-]*up|you should know)\W*$/i;
const TAG_LINE = new RegExp(
  String.raw`^[\s>*_"'“”‘’` + "`" + String.raw`]*tag[\s*_"'“”‘’` + "`" + String.raw`]*(?::\s*|[-–—](?:\s+|$))`,
  "i",
);
const QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
];
const CLOSERS = QUOTES.map(([, close]) => close).join("");
const ENDS_A_SENTENCE = new RegExp(`[.!?…][${CLOSERS})\\]]*$`);
const ENDS_WITH_QUESTION = new RegExp(`\\?[${CLOSERS}]?$`);
const ANSI = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*` +
    String.raw`(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*` +
    String.raw`|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?` +
    String.raw`(?:\u0007|\u001B\\|\u009C))` +
    String.raw`|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

const stripControl = (text: string) => text.replace(ANSI, "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");

const squash = (text: string) =>
  text
    .replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const dropTrailingPeriods = (text: string) => text.replace(/\.+$/, "");

function unquote(text: string): string {
  const trimmed = dropTrailingPeriods(text.trim());
  const quoted =
    trimmed.length >= 2 &&
    QUOTES.some(
      ([open, close]) => trimmed.startsWith(open) && trimmed.endsWith(close) && !trimmed.slice(1, -1).includes(close),
    );

  return quoted ? dropTrailingPeriods(trimmed.slice(1, -1).trim()) : trimmed;
}

const isNone = (text: string) => text === "" || /^none\s*(?:[.!?()[\]:;,-]|$)/i.test(text);

const tagOf = (text: string): Tag => (HEADS_UP.test(text) ? "Heads up" : "You should know");

// Reads the observer's `learn:` / `tag:` / `explain:` reply.
export function parseProposal(reply: string): Proposal {
  const raw = reply.split("\n");
  const cleaned = raw.map((line) => stripControl(line).trimStart());
  const learnAt = cleaned.findIndex((line) => LEARN.test(line.replace(BULLET, "")));
  const explainOffset = cleaned.slice(learnAt + 1).findIndex((line) => EXPLAIN.test(line));
  const hasExplain = learnAt !== -1 && explainOffset !== -1;
  const explainAt = hasExplain ? learnAt + 1 + explainOffset : -1;

  const explanation = hasExplain
    ? [(cleaned[explainAt] ?? "").replace(EXPLAIN, ""), ...raw.slice(explainAt + 1)].join("\n").trim()
    : "";

  const head = (hasExplain ? raw.slice(0, explainAt) : raw).map((line) =>
    squash(stripControl(line)).replace(BULLET, ""),
  );

  const tagLine = head.find((line) => TAG_LINE.test(line)) ?? "";
  const tag = tagOf(tagLine.replace(TAG_LINE, ""));

  for (const [index, line] of head.entries()) {
    if (!LEARN.test(line)) continue;

    let learn = line.replace(LEARN, "").trim();
    if (isNone(unquote(unquote(learn).replace(INLINE_TAG, "")))) return { kind: "none" };

    for (const next of head.slice(index + 1)) {
      if (next === "" || LEARN.test(next) || TAG_LINE.test(next) || ENDS_WITH_QUESTION.test(learn)) break;
      learn += ` ${next}`;
    }

    const unquoted = unquote(learn);
    const inline = INLINE_TAG.exec(unquoted);
    const body = inline === null ? unquoted : unquote(unquoted.slice(0, inline.index));
    const sentence = ENDS_A_SENTENCE.test(body) ? body : `${body}.`;
    const finalTag = tagLine === "" && inline !== null ? tagOf(inline[1] ?? "") : tag;

    if (sentence.length > MAX_LINE) continue;
    return { kind: "line", line: sentence, tag: finalTag, explanation: explanation || undefined };
  }

  return { kind: "unparsable" };
}

// For adapters with no second explain call, a line without its explanation is unparsable.
export function parseReply(reply: string): Reply {
  const proposal = parseProposal(reply);
  if (proposal.kind !== "line") return proposal;
  if (proposal.explanation === undefined) return { kind: "unparsable" };
  return { ...proposal, explanation: proposal.explanation };
}

const MAX_CARDS = 4;
const MAX_SKETCH_LINES = 12;
const MAX_SKETCH_WIDTH = 120;
const MAX_TITLE = 120;
const MAX_PROSE = 4000;
const FENCE = /^```/;
const TITLE = /^(?:\*\*([^*]+)\*\*|#+\s*(.+))$/;

const headOf = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");

function cutAtWord(text: string, length: number): string {
  if (text.length <= length) return text;
  const head = headOf(text, length - 1);
  const space = head.search(/\s\S*$/);
  const words = space === -1 ? "" : head.slice(0, space).trimEnd();
  return `${words.length > length / 2 ? words : head.trimEnd()}…`;
}

const prose = (text: string) =>
  text
    .split("\n")
    .map(squash)
    .filter((line) => line !== "")
    .join("\n");

// Splits an explanation into titled cards of lead prose, an optional fenced sketch
// and a caption, the shape the builtin draws.
export function parseExplanation(text: string): Card[] {
  const cards: Card[] = [];
  let card: Card = { title: "", lead: "", sketch: [], caption: "" };
  let inFence = false;
  let fenced = false;

  const flush = () => {
    card.lead = cutAtWord(prose(card.lead), MAX_PROSE);
    card.caption = cutAtWord(prose(card.caption), MAX_PROSE);
    if (card.title || card.lead || card.sketch.length > 0 || card.caption) cards.push(card);
    card = { title: "", lead: "", sketch: [], caption: "" };
  };

  for (const raw of text.split("\n")) {
    const line = stripControl(raw).replace(/\s+$/, "");

    if (FENCE.test(line.trim())) {
      if (!inFence && fenced) flush();
      inFence = !inFence;
      fenced = true;
      continue;
    }

    if (inFence) {
      if (card.sketch.length < MAX_SKETCH_LINES) card.sketch.push(headOf(line, MAX_SKETCH_WIDTH));
      continue;
    }

    const title = TITLE.exec(line.trim());
    if (title !== null) {
      flush();
      fenced = false;
      card.title = headOf(squash(title[1] ?? title[2] ?? ""), MAX_TITLE);
      continue;
    }

    const slot = card.sketch.length === 0 && !fenced ? "lead" : "caption";
    card[slot] += `\n${line}`;
  }

  flush();
  return cards.slice(0, MAX_CARDS);
}

export function cardText(card: Card): string {
  const sketch = card.sketch.length > 0 ? ["```", ...card.sketch, "```"].join("\n") : "";
  return [card.title === "" ? "" : `**${card.title}**`, card.lead, sketch, card.caption]
    .filter((part) => part !== "")
    .join("\n");
}

export const sameTopic = (left: string, right: string) =>
  left.toLowerCase().replace(/\.$/, "") === right.toLowerCase().replace(/\.$/, "");
