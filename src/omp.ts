import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseReply } from "./parse.ts";
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
import { chatNote, observerPrompt } from "./prompt.ts";
import type { Offer } from "./state.ts";
import { debugLog, readState, updateState } from "./store.ts";

const WIDGET = "you-should-know";

const LEARN_MORE = "Learn more";
const KNEW_THIS = "Knew this already";
const UNDERSTOOD = "Understood";
const CHAT = "Chat in main session";
const DISMISS = "Dismiss";
const TURN_OFF = "Turn off for this session";

export default function youShouldKnow(pi: ExtensionAPI): void {
  let offer: Offer | null = null;
  let checking = false;
  let off = false;
  let checks = 0;

  const show = (ctx: ExtensionContext) => {
    if (offer === null) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }

    const lines = offer.explained
      ? [`${offer.tag} · ${offer.line}`, "", ...offer.explanation.split("\n")]
      : [`${offer.tag} · ${offer.line}`, "/ysk to open"];

    ctx.ui.setWidget(WIDGET, lines, { placement: "aboveEditor" });
  };

  const close = async (ctx: ExtensionContext, known: boolean) => {
    const line = offer?.line;
    offer = null;
    show(ctx);

    await updateState((state) => {
      noteAnswered(state);
      if (known && line !== undefined) markKnown(state, line);
    });
  };

  async function check(ctx: ExtensionContext): Promise<void> {
    const run = ctx.runEphemeralTurn;
    if (run === undefined) return;

    const state = await readState();
    checks += 1;

    // Leaving `tools` unset keeps the main loop's tool list, so the request
    // reads the cached prefix. omp strips tool calls from side turns.
    const result = await run({
      promptText: observerPrompt(state.seen, state.known),
      conversationKey: `ysk-${checks}`,
    });

    const reply = parseReply(result.replyText);
    const usage = result.assistantMessage.usage;
    await debugLog({ harness: "omp", outcome: reply.kind, usage });

    if (reply.kind !== "line" || offer !== null || off) return;
    if (isRepeat(await readState(), reply.line)) return;

    await updateState((fresh) => markSeen(fresh, reply.line));
    offer = {
      tag: reply.tag,
      line: reply.line,
      explanation: reply.explanation,
      shownAt: Date.now(),
      promptsSurvived: 0,
      explained: false,
    };
    show(ctx);
  }

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || !ctx.hasUI || ctx.mode !== "tui") return;
    if (off || checking || offer !== null || !isCheckStep(event.turnIndex, checkEvery(process.env.YSK_CHECK_EVERY)))
      return;
    if (await updateState(takeSkip)) return;

    checking = true;
    // Detached, since turn_end handlers are awaited on a 30 s budget.
    void check(ctx)
      .catch((error: unknown) => debugLog({ harness: "omp", outcome: "error", error: String(error) }))
      .finally(() => {
        checking = false;
      });
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || offer === null || offer.explained) return;

    offer.promptsSurvived += 1;
    if (offer.promptsSurvived < CLEAR_AFTER_PROMPTS) return;

    offer = null;
    show(ctx);
    await updateState(noteIgnored);
  });

  pi.registerCommand("ysk", {
    description: "Open the current You should know note",
    handler: async (_args, ctx) => {
      if (offer === null) {
        ctx.ui.notify("You should know has nothing to show right now.", "info");
        return;
      }

      const current = offer;
      const first = current.explained
        ? await ctx.ui.select(current.line, [UNDERSTOOD, CHAT, DISMISS])
        : await ctx.ui.select(`${current.tag} · ${current.line}`, [LEARN_MORE, KNEW_THIS, CHAT, DISMISS, TURN_OFF]);

      if (first === LEARN_MORE) {
        current.explained = true;
        show(ctx);
        const next = await ctx.ui.select(current.line, [UNDERSTOOD, CHAT, DISMISS]);
        if (next === undefined) return;
        await answer(next, current, ctx);
        return;
      }

      if (first === undefined) return;
      await answer(first, current, ctx);
    },
  });

  async function answer(choice: string, current: Offer, ctx: ExtensionContext): Promise<void> {
    if (choice === TURN_OFF) off = true;
    if (choice === CHAT) ctx.ui.setEditorText(chatNote(current.tag, current.line, current.explanation));
    await close(ctx, choice === KNEW_THIS || choice === UNDERSTOOD);
  }
}
