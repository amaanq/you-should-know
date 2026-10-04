import type { Plugin } from "@opencode-ai/plugin";
import { parseReply } from "./parse.ts";
import { CLEAR_AFTER_PROMPTS, checkEvery, isCheckStep, isRepeat, markSeen, noteIgnored, takeSkip } from "./policy.ts";
import { observerPrompt } from "./prompt.ts";
import { session } from "./state.ts";
import { debugLog, readState, updateState } from "./store.ts";

const BLOCKED = "You should know side checks cannot run tools. Answer in text only.";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const YouShouldKnow: Plugin = async ({ client }) => {
  const forks = new Map<string, string>();
  const isMain = new Map<string, boolean>();
  const steps = new Map<string, number>();
  const userMessages = new Set<string>();
  const checking = new Set<string>();
  const busy = new Set<string>();

  async function main(id: string): Promise<boolean> {
    const known = isMain.get(id);
    if (known !== undefined) return known;

    const info = (await client.session.get({ path: { id } })).data;
    const result = info !== undefined && info.parentID === undefined && !forks.has(id);
    isMain.set(id, result);
    return result;
  }

  async function killFork(id: string): Promise<void> {
    await client.session.abort({ path: { id } }).catch(() => undefined);
    await client.session.delete({ path: { id } }).catch(() => undefined);

    await updateState((state) => {
      state.pendingForks = state.pendingForks.filter((fork) => fork.id !== id);
    });
  }

  // A fork outlives its check when opencode exits mid-check, and it would sit in
  // the session list for good. Forks owned by a live opencode are left alone.
  const orphans = (await readState()).pendingForks.filter((fork) => !alive(fork.pid));
  void Promise.all(orphans.map((fork) => killFork(fork.id))).catch(() => undefined);

  async function check(parent: string): Promise<void> {
    const history = (await client.session.messages({ path: { id: parent } })).data ?? [];
    const lastUser = history.findLast((entry) => entry.info.role === "user")?.info;
    if (lastUser?.role !== "user") return;

    const state = await readState();
    const parentInfo = (await client.session.get({ path: { id: parent } })).data as
      { permission?: unknown[] } | undefined;

    const fork = (await client.session.fork({ path: { id: parent } })).data;
    if (fork === undefined) return;

    forks.set(fork.id, parent);
    await updateState((fresh) => fresh.pendingForks.push({ id: fork.id, pid: process.pid }));
    let text = "";
    let cacheRead = 0;
    let input = 0;

    // The fork's request must match the parent's byte for byte to read its cache.
    // fork drops session permission rules, which prune the tool list, and passing
    // `tools` or `system` to the prompt would change the prefix again.
    try {
      const permission = parentInfo?.permission ?? [];

      if (permission.length > 0) {
        await client.session.update({ path: { id: fork.id }, body: { permission } as { title?: string } });
      }

      const reply = await client.session.prompt({
        path: { id: fork.id },
        body: {
          agent: lastUser.agent,
          model: lastUser.model,
          ...("variant" in lastUser ? { variant: lastUser.variant } : {}),
          parts: [{ type: "text", text: observerPrompt(state.seen, state.known) }],
        },
      });

      text = (reply.data?.parts ?? [])
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n");

      cacheRead = reply.data?.info.tokens.cache.read ?? 0;
      input = reply.data?.info.tokens.input ?? 0;
    } finally {
      await killFork(fork.id);
      forks.delete(fork.id);
    }

    const parsed = parseReply(text);
    await debugLog({ harness: "opencode", outcome: parsed.kind, cacheRead, input });
    if (parsed.kind !== "line") return;

    const shown = await updateState((fresh) => {
      const entry = session(fresh, parent);
      if (entry.off || entry.offer !== undefined || isRepeat(fresh, parsed.line)) return false;

      markSeen(fresh, parsed.line);
      entry.offer = {
        tag: parsed.tag,
        line: parsed.line,
        explanation: parsed.explanation,
        shownAt: Date.now(),
        promptsSurvived: 0,
        explained: false,
      };
      return true;
    });

    if (!shown) return;

    await client.tui.publish({
      body: { type: "tui.command.execute", properties: { command: "ysk.offer" } },
    });
  }

  async function onStep(id: string): Promise<void> {
    const step = (steps.get(id) ?? 0) + 1;
    steps.set(id, step);
    if (checking.has(id) || !isCheckStep(step, checkEvery(process.env.YSK_CHECK_EVERY)) || !(await main(id))) return;

    const ready = await updateState((state) => {
      const entry = session(state, id);
      return !entry.off && entry.offer === undefined && !takeSkip(state);
    });

    if (!ready) return;

    checking.add(id);
    void check(id)
      .catch((error: unknown) => debugLog({ harness: "opencode", outcome: "error", error: String(error) }))
      .finally(() => checking.delete(id));
  }

  async function onUserMessage(id: string, messageID: string): Promise<void> {
    if (userMessages.has(messageID) || !(await main(id))) return;
    userMessages.add(messageID);
    steps.set(id, 0);

    await updateState((state) => {
      const offer = state.sessions[id]?.offer;
      if (offer === undefined || offer.explained) return;

      offer.promptsSurvived += 1;
      if (offer.promptsSurvived < CLEAR_AFTER_PROMPTS) return;

      delete session(state, id).offer;
      noteIgnored(state);
    });
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        if (event.properties.status.type === "idle") busy.delete(event.properties.sessionID);
        else busy.add(event.properties.sessionID);
        return;
      }

      if (event.type === "message.updated" && event.properties.info.role === "user") {
        await onUserMessage(event.properties.info.sessionID, event.properties.info.id);
        return;
      }

      if (event.type !== "message.part.updated") return;
      const part = event.properties.part;

      if (forks.has(part.sessionID)) {
        if (part.type === "tool") await killFork(part.sessionID);
        return;
      }

      // Forking replays every copied part as an update while the fork is idle, so
      // only steps of a running session count.
      if (part.type === "step-finish" && busy.has(part.sessionID)) await onStep(part.sessionID);
    },

    "tool.execute.before": async (input) => {
      if (forks.has(input.sessionID)) throw new Error(BLOCKED);
    },

    // opencode keys OpenAI-style prompt caching and routing by session ID, and a
    // fork has a fresh one. Point both back at the parent.
    "chat.params": async (input, output) => {
      const parent = forks.get(input.sessionID);
      if (parent === undefined) return;

      if ("promptCacheKey" in output.options) output.options.promptCacheKey = parent;
      if ("prompt_cache_key" in output.options) output.options.prompt_cache_key = parent;
    },

    "chat.headers": async (input, output) => {
      const parent = forks.get(input.sessionID);
      if (parent === undefined) return;

      output.headers["x-opencode-session-id"] = parent;

      if (input.model.providerID.startsWith("opencode")) {
        output.headers["x-opencode-session"] = parent;
        return;
      }

      output.headers["x-session-affinity"] = parent;
      output.headers["X-Session-Id"] = parent;
    },
  };
};
