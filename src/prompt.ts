import explain from "../prompts/explain.md" with { type: "text" };
import frame from "../prompts/frame.md" with { type: "text" };
import observer from "../prompts/observer.md" with { type: "text" };
import type { Tag } from "./parse.ts";

export type Direction = "simpler_words" | "less_detail" | "more_detail";

const ASKED: Record<Direction, string> = {
  simpler_words: "in simpler words",
  less_detail: "with less detail",
  more_detail: "in more detail",
};

const LENGTH: Record<Direction | "first", string> = {
  first: "At most 100 words; fewer when the thing needs no introduction.",
  simpler_words:
    "Same content as before, said more plainly: shorter sentences, everyday words, no symbols or arrows, no technical terms at all. At most 100 words.",
  less_detail:
    "Strip it to the single most important point: what the thing is in one clause, then the one consequence and the choice. No technical terms, no sketch. At most 45 words.",
  more_detail:
    "Now name the real parts: show the actual config keys, file or function involved (each introduced as everyday words then the name in backticks), and one edge case that would surprise them. Still for a reader with no context; still no invented terms. At most 160 words; a sketch of the real structure is welcome here if it helps.",
};

const bullets = (items: readonly string[]) =>
  items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(nothing yet)";

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.split(`{{${key}}}`).join(value), template);

export const observerPrompt = (seen: readonly string[], known: readonly string[]) =>
  `${frame}\n${fill(observer, { seen: bullets(seen), known: bullets(known) })}`;

export interface Rewrite {
  direction: Direction;
  previous: string;
}

export function explainPrompt(line: string, rewrite?: Rewrite): string {
  const previous =
    rewrite === undefined
      ? ""
      : `You already showed them this, and they asked for it ${ASKED[rewrite.direction]}:\n"""\n${rewrite.previous}\n"""\nDo not repeat it; rewrite it.\n\n`;

  return `${frame}\n${fill(explain, { line, previous, length: LENGTH[rewrite?.direction ?? "first"] })}`;
}

const INVISIBLE = new RegExp(
  String.raw`(?<!\p{Extended_Pictographic})(?<![#*0-9](?=\uFE0F\u20E3))[\uFE0E\uFE0F]` +
    String.raw`|[^\P{Default_Ignorable_Code_Point}\uFE0E\uFE0F]|[\u{1107F}\u{16FE4}]`,
  "gu",
);

const PLACEHOLDER = new RegExp(
  String.raw`\[(Pasted text|Image|\.\.\.Truncated text|\u2726 Team setup guide) #(\d+)(?: \+\d+ lines)?(\.)*\]`,
  "g",
);

// A pasted note must not attach files through `@`, expand placeholders, or fire
// an ultra* keyword once the composer reads it.
const draftSafe = (text: string) =>
  text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(INVISIBLE, "")
    .replace(/(^|[\s\u3002\u3001\uFF1F\uFF01])@(?!\s)/g, "$1\uFF20")
    .replace(PLACEHOLDER, (match) => `\uFF3B${match.slice(1)}`)
    .replace(/(ultra)(code|plan|review|think)/gi, "$1-$2");

// The same quoted note the builtin pastes into the composer for "Chat in main session".
export function chatNote(tag: Tag, line: string, explanation: string): string {
  const quoted = `${tag} · ${line}\n\n${explanation}`
    .split("\n")
    .map((row) => (row === "" ? ">" : `> ${row}`))
    .join("\n");

  return draftSafe(`Here is a note offered by a side agent:\n\n${quoted}`);
}
