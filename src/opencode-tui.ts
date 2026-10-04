import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { markKnown, noteAnswered } from "./policy.ts";
import { chatNote } from "./prompt.ts";
import { session, type Offer } from "./state.ts";
import { readState, updateState } from "./store.ts";

type Choice = "learn" | "known" | "understood" | "chat" | "dismiss" | "off";

function currentSession(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  const params = "params" in route ? (route.params as Record<string, unknown> | undefined) : undefined;
  return typeof params?.sessionID === "string" ? params.sessionID : undefined;
}

async function latestOffer(api: TuiPluginApi): Promise<[string, Offer] | undefined> {
  const state = await readState();
  const here = currentSession(api);
  const offer = here === undefined ? undefined : state.sessions[here]?.offer;
  if (here !== undefined && offer !== undefined) return [here, offer];

  const all = Object.entries(state.sessions).flatMap(([id, entry]) =>
    entry.offer === undefined ? [] : [[id, entry.offer] as [string, Offer]],
  );

  return all.sort(([, left], [, right]) => right.shownAt - left.shownAt)[0];
}

async function answer(api: TuiPluginApi, id: string, offer: Offer, choice: Choice): Promise<void> {
  api.ui.dialog.clear();

  if (choice === "chat") {
    await api.client.tui.appendPrompt({ text: chatNote(offer.tag, offer.line, offer.explanation) });
  }

  await updateState((state) => {
    const entry = session(state, id);
    delete entry.offer;
    noteAnswered(state);
    if (choice === "known" || choice === "understood") markKnown(state, offer.line);
    if (choice === "off") entry.off = true;
  });
}

function explain(api: TuiPluginApi, id: string, offer: Offer): void {
  void updateState((state) => {
    const pending = state.sessions[id]?.offer;
    if (pending !== undefined) pending.explained = true;
  });

  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: offer.line,
      message: offer.explanation,
      onConfirm: () => {
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect<Choice>({
            title: offer.line,
            options: [
              { title: "Understood", value: "understood" },
              { title: "Chat in main session", value: "chat" },
              { title: "Dismiss", value: "dismiss" },
            ],
            onSelect: (option) => void answer(api, id, offer, option.value),
          }),
        );
      },
    }),
  );
}

async function open(api: TuiPluginApi): Promise<void> {
  const found = await latestOffer(api);

  if (found === undefined) {
    api.ui.toast({ message: "You should know has nothing to show right now." });
    return;
  }

  const [id, offer] = found;
  if (offer.explained) {
    explain(api, id, offer);
    return;
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<Choice>({
      title: `${offer.tag} · ${offer.line}`,
      options: [
        { title: "Learn more", value: "learn" },
        { title: "Knew this already", value: "known" },
        { title: "Chat in main session", value: "chat" },
        { title: "Dismiss", value: "dismiss" },
        { title: "Turn off for this session", value: "off" },
      ],
      onSelect: (option) => {
        if (option.value === "learn") explain(api, id, offer);
        else void answer(api, id, offer, option.value);
      },
    }),
  );
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "ysk.offer",
        title: "You should know: announce a new note",
        run() {
          void latestOffer(api).then((found) => {
            if (found === undefined) return;
            api.ui.toast({ title: found[1].tag, message: `${found[1].line}\n/ysk to open`, duration: 15_000 });
          });
        },
      },
      {
        name: "ysk.open",
        title: "You should know",
        slashName: "ysk",
        category: "Session",
        namespace: "palette",
        run() {
          void open(api);
        },
      },
    ],
  });
};

export default { id: "you-should-know", tui };
