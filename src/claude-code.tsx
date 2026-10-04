import type { EngineInterface, ModelForkResult, On, RenderChildren, RenderSurface } from "claude-code";
import { cardText, parseExplanation, parseProposal, type Card, type Tag } from "./parse.ts";
import {
  CLEAR_AFTER_PROMPTS,
  checkEvery,
  isCheckStep,
  isRepeat,
  markKnown,
  markSeen,
  noteAnswered,
  noteIgnored,
  takeSkip,
} from "./policy.ts";
import { chatNote, explainPrompt, observerPrompt, type Direction } from "./prompt.ts";
import { parseState, serializeState, type State } from "./state.ts";

type $ = EngineInterface;

type View =
  | {
      kind: "offer";
      tag: Tag;
      line: string;
      explanation?: string;
      shownAt: number;
      promptsSurvived: number;
      isOffArmed?: boolean;
    }
  | { kind: "explaining"; tag: Tag; line: string; shownAt: number }
  | { kind: "explained"; tag: Tag; line: string; text: string; iteration: number; shownAt: number }
  | { kind: "asked"; tag: Tag; line: string; text?: string; iteration?: number; shownAt: number }
  | { kind: "failed" };

interface Session {
  id: string;
  view?: View;
  offeredTurn?: string;
  askedTurn?: string;
  isAboutOpen?: boolean;
  touchedAt: number;
}

const SESSIONS_KEPT = 32;
const ASKED_MS = 20_000;
const STAR = "✦";
const CHOICE_GAP = 3;
const STAR_WIDTH = 2;

const ABOUT: ReadonlyArray<{ text: string; look?: "bold" | "code" }> = [
  { text: "A side agent is watching your back while the model works. " },
  { text: "When something comes up that you should know but might miss, it flags it for you. " },
  { text: "Learn more", look: "bold" },
  { text: " for a deeper explanation you can chat about. " },
  { text: "/ysk off", look: "code" },
  { text: " turns it off." },
];

const sessionsOf = (value: unknown): Session[] =>
  Array.isArray(value) ? value.filter((one): one is Session => typeof one?.id === "string") : [];

async function readSession($: $, id: string): Promise<Session> {
  return sessionsOf(await $.store.get("sessions")).find((one) => one.id === id) ?? { id, touchedAt: 0 };
}

async function writeSession($: $, id: string, change: (session: Session) => void): Promise<void> {
  const sessions = sessionsOf(await $.store.get("sessions"));
  const session = sessions.find((one) => one.id === id) ?? { id, touchedAt: 0 };
  change(session);
  session.touchedAt = Date.now();

  const rest = sessions.filter((one) => one.id !== id).sort((left, right) => right.touchedAt - left.touchedAt);
  await $.store.set("sessions", [session, ...rest].slice(0, SESSIONS_KEPT));
}

function setView($: $, id: string, view: View | undefined): Promise<void> {
  return writeSession($, id, (session) => {
    session.view = view;
    if (view === undefined) session.isAboutOpen = false;
  });
}

const usageOf = (reply: ModelForkResult) => ("usage" in reply ? reply.usage : undefined);

const truthy = (value: string | undefined) => ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

async function statePaths($: $) {
  const home = (await $.env.get("XDG_STATE_HOME")) || `${await $.env.get("HOME")}/.local/state`;
  const dir = `${home}/you-should-know`;
  return { dir, state: `${dir}/state.json`, debug: `${dir}/debug.jsonl` };
}

async function readShared($: $): Promise<State> {
  return parseState(await $.fs.read((await statePaths($)).state).catch(() => undefined));
}

let sharedWrites: Promise<unknown> = Promise.resolve();

// The other adapters read this file mid-write, and one that parses a torn file
// as empty writes that back, so it lands by rename.
function updateShared<T>($: $, change: (state: State) => T): Promise<T> {
  const write = async () => {
    const paths = await statePaths($);
    const state = parseState(await $.fs.read(paths.state).catch(() => undefined));
    const result = change(state);
    const temp = `${paths.state}.${crypto.randomUUID()}`;
    await $.fs.write(temp, serializeState(state));
    await $.process.run(["mv", "-f", temp, paths.state]);
    return result;
  };

  const next = sharedWrites.then(write);
  sharedWrites = next.catch(() => undefined);
  return next;
}

async function debugLog($: $, entry: Record<string, unknown>): Promise<void> {
  if (!truthy(await $.env.get("YSK_DEBUG"))) return;
  const { debug } = await statePaths($);
  const before = await $.fs.read(debug).catch(() => "");
  const line = JSON.stringify({ at: new Date().toISOString(), harness: "claude-code", ...entry });
  await $.fs.write(debug, `${before}${line}\n`);
}

const HARD_BREAK = "  \n";
const LIST_MARKER = /^(?:[-*+•]|(\d+)([.)]))\s+/;
const LEADING_NUMBER = /^(\d+)([.)])(?=\s|$)/;
const MARKUP = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|[\\`*_{}[<>#+\-=|~^$&:@]|(?<=[wW]{3})\./g;
const STRUCTURAL = /[\\`*_{}[<>#+\-=|~^$&:@]|(?<=[wW]{3})\./g;

interface Shape {
  kind: "plain" | "bullet" | "ordered";
  text: string;
  opensInPlace: boolean;
  ordinal?: number;
}

// The model's prose keeps its bold and code spans and nothing else, so a stray
// `#` or `-` can't turn a sentence into a heading or a list.
const literal = (text: string) =>
  text
    .trimStart()
    .replace(MARKUP, (match, bold: string | undefined, code: string | undefined) => {
      if (code !== undefined) return match;
      return bold !== undefined ? `**${bold.replace(STRUCTURAL, "\\$&")}**` : `\\${match}`;
    })
    .replace(LEADING_NUMBER, "$1\\$2");

function shapeOf(line: string, previousOrdinal?: number): Shape {
  const trimmed = line.trimStart();
  const marker = LIST_MARKER.exec(trimmed);
  const text = literal(trimmed.slice(marker?.[0].length ?? 0));
  if (marker === null) return { kind: "plain", text, opensInPlace: false };

  const digits = marker[1];
  if (digits === undefined) return { kind: "bullet", text: `- ${text}`, opensInPlace: true };

  const ordinal = Number(digits);
  const continues = `${(previousOrdinal ?? ordinal - 1) + 1}.` === `${digits}${marker[2]}`;

  return continues
    ? { kind: "ordered", text: `${ordinal}. ${text}`, opensInPlace: ordinal === 1, ordinal }
    : { kind: "plain", text: `${digits}\\${marker[2]} ${text}`, opensInPlace: false };
}

function proseMarkdown(text: string, title: string): string {
  const head: Shape[] =
    title === "" ? [] : [{ kind: "plain", text: `**${title.replace(STRUCTURAL, "\\$&")}**`, opensInPlace: false }];

  const shapes = text
    .split("\n")
    .filter((line) => line !== "")
    .reduce<Shape[]>((drawn, line) => {
      const previous = drawn.at(-1);
      const shape = shapeOf(line, previous?.ordinal);
      if (previous === undefined) return [...drawn, shape];

      const isPlain = shape.kind === "plain";
      const gap =
        isPlain && previous.kind === "plain"
          ? HARD_BREAK
          : (!isPlain && shape.kind === previous.kind) || shape.opensInPlace
            ? "\n"
            : "\n\n";

      return [...drawn, { ...shape, text: `${gap}${shape.text}` }];
    }, head);

  const body = shapes.map((shape) => shape.text).join("");
  return body === "" ? "" : `${body}\n\n`;
}

interface Choice {
  hotkey: string;
  label: string;
  onPress: () => void;
  isDim?: boolean;
  isDismiss?: boolean;
}

const checking = new Set<string>();
const explaining = new Set<string>();
const responding = new Set<string>();
const ended = new Set<string>();
const promptsTyped = new Map<string, number>();
const askedTimers = new Map<string, { cancel: () => void }>();
const drawnOn = new Set<RenderSurface>();

function redraw($: $): void {
  $.ui.invalidate("ui.render");
}

async function answered($: $, line: string, isKnown: boolean): Promise<void> {
  await updateShared($, (state) => {
    noteAnswered(state);
    if (isKnown) markKnown(state, line);
  });
}

async function close($: $, id: string): Promise<void> {
  askedTimers.get(id)?.cancel();
  askedTimers.delete(id);
  await setView($, id, undefined);
  redraw($);
}

async function ask($: $, id: string, view: Extract<View, { kind: "asked" }>): Promise<void> {
  await setView($, id, view);
  redraw($);
  askedTimers.get(id)?.cancel();

  askedTimers.set(
    id,
    $.clock.after(ASKED_MS, async () => {
      askedTimers.delete(id);
      if ((await readSession($, id)).view?.kind === "asked") await close($, id);
    }),
  );
}

async function explain(
  $: $,
  id: string,
  tag: Tag,
  line: string,
  rewrite?: { direction: Direction; previous: string; iteration: number },
) {
  if (explaining.has(id)) return;
  explaining.add(id);

  try {
    await setView($, id, { kind: "explaining", tag, line, shownAt: Date.now() });
    redraw($);

    const reply = await $.model.fork({ prompt: explainPrompt(line, rewrite) }).catch(() => undefined);
    const text = reply?.isAnswered ? reply.text.trim() : "";
    await debugLog($, {
      outcome: "explain",
      direction: rewrite?.direction ?? "first",
      usage: reply === undefined ? undefined : usageOf(reply),
    });

    if (text !== "" && parseExplanation(text).length > 0) {
      await setView($, id, {
        kind: "explained",
        tag,
        line,
        text,
        iteration: (rewrite?.iteration ?? 0) + 1,
        shownAt: Date.now(),
      });
    } else if (rewrite !== undefined) {
      await setView($, id, {
        kind: "explained",
        tag,
        line,
        text: rewrite.previous,
        iteration: rewrite.iteration,
        shownAt: Date.now(),
      });
    } else {
      await setView($, id, { kind: "failed" });
    }

    promptsTyped.delete(id);
    redraw($);
  } finally {
    explaining.delete(id);
  }
}

async function respond($: $, id: string, view: Extract<View, { kind: "explained" }>): Promise<void> {
  if (responding.has(id)) return;
  responding.add(id);

  try {
    const box = await $.prompt.read().catch(() => undefined);

    if (box !== undefined && box.text.trim() !== "") {
      $.ui.toast("Your prompt box has text in it. Send or clear it, then press 2 again.");
      return;
    }

    const note = chatNote(view.tag, view.line, parseExplanation(view.text).map(cardText).join("\n\n"));
    const filled = await $.prompt.fill({ text: `${note}\n\n`, mode: "replace" }).catch(() => undefined);

    if (filled?.isFilled !== true && filled?.refusal !== "no_composer") {
      $.ui.toast(
        filled?.refusal === "dialog"
          ? "A dialog has the keyboard. Answer it, then press 2 again."
          : "The prompt box didn't take the note. Press 2 to try again.",
      );
      return;
    }

    await answered($, view.line, true);
    await close($, id);
    if (filled?.isFilled !== true) await $.prompt.submit({ text: note }).catch(() => undefined);
  } finally {
    responding.delete(id);
  }
}

async function turnOff($: $, id: string): Promise<void> {
  await $.store.set("off", true);
  await close($, id);
  $.ui.toast("You should know is off. /ysk on turns it back on.");
}

async function onStep($: $, index: number, turnId: string, id: string): Promise<void> {
  let session = await readSession($, id);

  if (session.view?.kind === "explaining" && !explaining.has(id)) {
    await setView($, id, undefined);
    session = await readSession($, id);
  }

  if (index === 0) {
    const typed = promptsTyped.get(id) ?? 0;
    promptsTyped.delete(id);
    const view = session.view;

    if (view?.kind === "asked") await close($, id);
    if (view?.kind !== "offer" || typed === 0) return;

    const survived = view.promptsSurvived + typed;

    if (survived < CLEAR_AFTER_PROMPTS) {
      await setView($, id, { ...view, promptsSurvived: survived, isOffArmed: false });
      redraw($);
      return;
    }

    await close($, id);
    await updateShared($, noteIgnored);
    await debugLog($, { outcome: "ignored", line: view.line });
    return;
  }

  if ((await $.store.get("off")) === true || checking.has(id)) return;
  if (session.view !== undefined || session.offeredTurn === turnId) return;
  if (!isCheckStep(index, checkEvery(await $.env.get("YSK_CHECK_EVERY")))) return;
  if (await updateShared($, takeSkip)) return;

  checking.add(id);

  try {
    await writeSession($, id, (fresh) => {
      fresh.askedTurn = turnId;
    });

    const state = await readShared($);
    const reply = await $.model.fork({ prompt: observerPrompt(state.seen, state.known) });
    const proposal = reply.isAnswered ? parseProposal(reply.text) : undefined;
    await debugLog($, {
      outcome: reply.isAnswered ? proposal?.kind : reply.reason,
      step: index,
      usage: usageOf(reply),
    });

    if (proposal?.kind !== "line" || isRepeat(await readShared($), proposal.line)) return;

    const fresh = await readSession($, id);
    if (fresh.askedTurn !== turnId || fresh.view !== undefined || ended.has(id)) return;

    await updateShared($, (shared) => markSeen(shared, proposal.line));

    await writeSession($, id, (current) => {
      current.offeredTurn = turnId;
      current.view = {
        kind: "offer",
        tag: proposal.tag,
        line: proposal.line,
        explanation: proposal.explanation,
        shownAt: Date.now(),
        promptsSurvived: 0,
      };
    });

    promptsTyped.delete(id);
    redraw($);
  } finally {
    checking.delete(id);
  }
}

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "ysk",
      description: "You should know: on, off, status, or forget what you marked as known",
      argumentHint: "on | off | status | forget",
    });

    return next(e);
  });

  on("command.run", { command: "ysk" }, async ($, e) => {
    const verb = e.args.trim().toLowerCase();

    if (verb === "off") {
      await turnOff($, await $.session.id());
      return { text: "You should know is off." };
    }

    if (verb === "on") {
      await $.store.set("off", false);
      return { text: "You should know is on." };
    }

    if (verb === "forget") {
      await updateShared($, (state) => {
        state.known = [];
        state.seen = [];
      });
      return { text: "Forgot every topic seen or marked known, across all harnesses." };
    }

    const state = await readShared($);
    const off = (await $.store.get("off")) === true;
    const every = checkEvery(await $.env.get("YSK_CHECK_EVERY"));

    return {
      text: [
        `You should know is ${off ? "off" : "on"}, checking every ${every} steps.`,
        `${state.seen.length} topics seen, ${state.known.length} marked known.`,
        state.skipsLeft > 0
          ? `Skipping the next ${state.skipsLeft} checks after ${state.ignoredInARow} ignored offers.`
          : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    };
  });

  on("prompt.submit", async ($, e, next) => {
    const kind = e.origin.kind;

    if (kind === "composer" || kind === "bridge") {
      const id = await $.session.id();
      promptsTyped.set(id, (promptsTyped.get(id) ?? 0) + 1);
    }

    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);

    void (async () => {
      const surfaces = await $.session.surfaces();
      if (!surfaces.some((surface) => surface === "terminal" || drawnOn.has(surface))) return;
      await onStep($, e.index, e.turnId, await $.session.id());
    })().catch((error: unknown) => debugLog($, { outcome: "error", error: String(error) }));

    return yield* next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    drawnOn.add(e.surface);

    const id = await $.session.id();
    const session = await readSession($, id);
    const view = session.view;

    if (view === undefined || (e.props.hasSurvey && view.kind !== "explained")) return next(e);

    const elements = $.ui.resolve(e);
    const { Box, Text, Markdown, Code } = elements;
    const isTerminal = e.surface === "terminal";

    const button = ({ hotkey, label, onPress, isDim, isDismiss }: Choice) => (
      <Box marginRight={CHOICE_GAP}>
        {isTerminal ? (
          <elements.Button
            hotkey={hotkey}
            plain
            dimColor={isDim}
            role={isDismiss ? "dismiss" : undefined}
            onPress={onPress}
          >
            {label}
          </elements.Button>
        ) : (
          <elements.Button dimColor={isDim} role={isDismiss ? "dismiss" : undefined} onPress={onPress}>
            {label}
          </elements.Button>
        )}
      </Box>
    );

    const choices = (list: Choice[]) => (
      <Box marginLeft={STAR_WIDTH} flexWrap="wrap">
        {list.map(button)}
      </Box>
    );

    const starred = (tag: Tag | undefined, body: RenderChildren) => (
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} width={STAR_WIDTH}>
          <Text color="suggestion">{STAR}</Text>
        </Box>
        <Text wrap="wrap">
          {tag === undefined ? "" : <Text dimColor>{tag} · </Text>}
          {body}
        </Text>
      </Box>
    );

    const still = (text: string) => (
      <Box marginTop={1}>
        <Text color="suggestion">{STAR}</Text>
        <Text wrap="truncate-end" dimColor>
          {" "}
          {text}
        </Text>
      </Box>
    );

    // One press per drawing, so a double tap can't answer twice.
    let isPressed = false;
    const once = (run: () => Promise<void>) => () => {
      if (isPressed) return;
      isPressed = true;
      void run();
    };

    if (view.kind === "explaining") return still("One moment…");

    if (view.kind === "failed") {
      return (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text color="suggestion">{STAR}</Text> Couldn’t write that explanation <Text dimColor>·</Text>{" "}
          </Text>
          {button({ hotkey: "0", label: "OK", onPress: once(() => close($, id)) })}
        </Box>
      );
    }

    if (view.kind === "asked") {
      const wasExplained = view.text !== undefined;
      const simpler = once(async () => {
        askedTimers.get(id)?.cancel();
        await answered($, view.line, false);
        await explain(
          $,
          id,
          view.tag,
          view.line,
          view.text === undefined
            ? undefined
            : { direction: "simpler_words", previous: view.text, iteration: view.iteration ?? 1 },
        );
      });

      const list: Choice[] = [
        {
          hotkey: "1",
          label: "That was helpful",
          onPress: once(async () => {
            await answered($, view.line, true);
            await close($, id);
          }),
        },
        ...(wasExplained
          ? []
          : [
              {
                hotkey: "2",
                label: "Not relevant",
                onPress: once(async () => {
                  await answered($, view.line, false);
                  await close($, id);
                }),
              },
            ]),
        {
          hotkey: wasExplained ? "2" : "3",
          label: wasExplained ? "Didn’t understand" : "Couldn’t understand",
          onPress: simpler,
        },
        ...(isTerminal && !wasExplained
          ? [{ hotkey: "4", label: "Turn off suggestions", onPress: once(() => turnOff($, id)) }]
          : []),
        { hotkey: "0", label: "Dismiss", onPress: once(() => close($, id)), isDismiss: true },
      ];

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" alignItems="flex-start">
            <Box flexShrink={0} width={STAR_WIDTH}>
              <Text color="suggestion">{STAR}</Text>
            </Box>
            <Box flexWrap="wrap">
              <Box marginRight={CHOICE_GAP}>
                <Text dimColor wrap="truncate-end">
                  Dismissed.
                </Text>
              </Box>
              {list.map(button)}
            </Box>
          </Box>
        </Box>
      );
    }

    if (view.kind === "explained") {
      const cards: Card[] = parseExplanation(view.text);
      const rewrite = (direction: Direction) =>
        once(() => explain($, id, view.tag, view.line, { direction, previous: view.text, iteration: view.iteration }));

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column" marginBottom={1}>
            {starred(view.tag, view.line)}
          </Box>
          {cards.map((card) => {
            const lead = proseMarkdown(card.lead, card.title);
            const caption = proseMarkdown(card.caption, "");

            return (
              <Box flexDirection="column" marginBottom={1} marginLeft={STAR_WIDTH}>
                {lead === "" ? "" : <Markdown text={lead} />}
                {card.sketch.length === 0 ? (
                  ""
                ) : (
                  <Code
                    source={card.sketch.map((row) => (row === "" ? " " : row)).join("\n")}
                    language="text"
                    wrap="truncate-end"
                  />
                )}
                {caption === "" ? "" : <Markdown text={caption} />}
              </Box>
            );
          })}
          {e.props.hasSurvey
            ? ""
            : choices([
                {
                  hotkey: "1",
                  label: "Understood",
                  onPress: once(async () => {
                    await answered($, view.line, true);
                    await close($, id);
                  }),
                },
                { hotkey: "2", label: "Chat in main session", onPress: once(() => respond($, id, view)) },
                { hotkey: "3", label: "Simpler words", onPress: rewrite("simpler_words"), isDim: true },
                { hotkey: "4", label: "Shorter", onPress: rewrite("less_detail"), isDim: true },
                { hotkey: "5", label: "More detail", onPress: rewrite("more_detail"), isDim: true },
                {
                  hotkey: "0",
                  label: "Dismiss",
                  isDismiss: true,
                  onPress: once(() =>
                    ask($, id, {
                      kind: "asked",
                      tag: view.tag,
                      line: view.line,
                      text: view.text,
                      iteration: view.iteration,
                      shownAt: Date.now(),
                    }),
                  ),
                },
              ])}
        </Box>
      );
    }

    const learn = once(async () => {
      await answered($, view.line, false);

      if (view.explanation !== undefined && parseExplanation(view.explanation).length > 0) {
        await setView($, id, {
          kind: "explained",
          tag: view.tag,
          line: view.line,
          text: view.explanation,
          iteration: 1,
          shownAt: Date.now(),
        });
        promptsTyped.delete(id);
        redraw($);
        return;
      }

      await explain($, id, view.tag, view.line);
    });

    const disable = () => {
      if (view.isOffArmed === true) return once(() => turnOff($, id))();

      void setView($, id, { ...view, isOffArmed: true }).then(() => redraw($));
    };

    const about = () => {
      void writeSession($, id, (current) => {
        current.isAboutOpen = current.isAboutOpen !== true;
      }).then(() => redraw($));
    };

    return (
      <Box flexDirection="column" marginTop={1}>
        {session.isAboutOpen === true
          ? starred(
              undefined,
              ABOUT.map(({ text, look }) =>
                look === "bold" ? (
                  <Text bold>{text}</Text>
                ) : look === "code" ? (
                  <Text color="permission">{text}</Text>
                ) : (
                  <Text dimColor>{text}</Text>
                ),
              ),
            )
          : starred(view.tag, view.line)}
        {choices([
          { hotkey: "1", label: "Learn more", onPress: learn },
          {
            hotkey: "2",
            label: "Knew this already",
            onPress: once(async () => {
              await answered($, view.line, true);
              await close($, id);
            }),
          },
          {
            hotkey: "3",
            label: session.isAboutOpen === true ? "Return to topic" : "What is this",
            onPress: about,
            isDim: true,
          },
          ...(isTerminal
            ? [
                {
                  hotkey: "4",
                  label: view.isOffArmed === true ? "Press again to disable" : "Disable",
                  onPress: disable,
                  isDim: true,
                },
              ]
            : []),
          {
            hotkey: "0",
            label: "Dismiss",
            isDismiss: true,
            onPress: once(() => ask($, id, { kind: "asked", tag: view.tag, line: view.line, shownAt: Date.now() })),
          },
        ])}
      </Box>
    );
  });

  on("session.end", async ($, e, next) => {
    ended.add(e.sessionId);
    promptsTyped.delete(e.sessionId);
    askedTimers.get(e.sessionId)?.cancel();
    askedTimers.delete(e.sessionId);

    if ((await readSession($, e.sessionId)).view !== undefined) await setView($, e.sessionId, undefined);

    return next(e);
  });
}
