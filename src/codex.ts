import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReply } from "./parse.ts";
import { checkEvery, isCheckStep, isRepeat, markKnown, markSeen, noteAnswered, takeSkip } from "./policy.ts";
import { observerPrompt } from "./prompt.ts";
import { session } from "./state.ts";
import { debugLog, readState, updateState, withCheckLock } from "./store.ts";

const SIDE_ENV = "YSK_SIDE_CALL";
const SIDE_TIMEOUT_MS = 150_000;

interface HookInput {
  hook_event_name: string;
  session_id: string;
  turn_id?: string;
  model?: string;
  cwd: string;
  prompt?: string;
}

interface Ancestor {
  pid: number;
  args: string[];
}

function ancestors(): Ancestor[] {
  const chain: Ancestor[] = [];
  let pid = process.ppid;

  while (pid > 1 && chain.length < 32) {
    const ps = Bun.spawnSync(["ps", "-o", "ppid=", "-o", "args=", "-p", String(pid)]);
    const row = ps.stdout.toString().trim();
    if (row === "") break;

    const [parent, ...args] = row.split(/\s+/);
    chain.push({ pid, args });
    pid = Number(parent);
  }

  return chain;
}

const isSideCall = (args: readonly string[]) =>
  args.includes("exec") && args.includes("fork") && args.includes("--ephemeral");

// Codex has shipped PreToolUse denies that did not stop apply_patch writes
// (openai/codex#27833), so the side call is killed outright before any tool runs.
function stopSideCall(): void {
  const fork = ancestors().find((ancestor) => isSideCall(ancestor.args));
  if (fork !== undefined) process.kill(fork.pid, "SIGKILL");

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "You should know side checks cannot run tools. Answer in text only.",
      },
    }),
  );
}

const VALUE_FLAGS = new Set(["-p", "--profile", "-s", "--sandbox", "-c", "--config"]);
const BARE_FLAGS = new Set(["--dangerously-bypass-approvals-and-sandbox"]);

// The fork must see the parent's profile and sandbox, since those pick the tool
// list and a different list misses the cache.
function parentFlags(codex: readonly string[]): string[] {
  const flags: string[] = [];

  for (const [index, arg] of codex.entries()) {
    const value = codex[index + 1];
    if (BARE_FLAGS.has(arg)) flags.push(arg);
    if (VALUE_FLAGS.has(arg) && value !== undefined) flags.push(arg, value);
  }

  return flags;
}

// herdr's hook reports to the pane in HERDR_PANE_ID and exits early without
// HERDR_ENV, so the fork's turns would otherwise show as the pane's agent state.
function sideEnv(): Record<string, string | undefined> {
  const { HERDR_ENV: _herdr, ...rest } = process.env;
  return { ...rest, [SIDE_ENV]: "1" };
}

// Codex skips hooks whose hash is not trusted in config.toml, and the PreToolUse
// block must run before the user ever approves it, hence the trust bypass.
async function sideCall(input: HookInput, prompt: string): Promise<{ text: string; usage: unknown }> {
  const parent = ancestors().find((ancestor) => /(^|\/)codex$/.test(ancestor.args[0] ?? ""));
  const binary = parent?.args[0] ?? "codex";
  const dir = await mkdtemp(join(tmpdir(), "ysk-"));
  const out = join(dir, "last.txt");

  try {
    const child = Bun.spawn(
      [
        binary,
        "exec",
        ...parentFlags(parent?.args ?? []),
        ...(input.model === undefined ? [] : ["-m", input.model]),
        "--skip-git-repo-check",
        "--dangerously-bypass-hook-trust",
        "fork",
        input.session_id,
        "--ephemeral",
        "--json",
        "-o",
        out,
        "-",
      ],
      {
        cwd: input.cwd,
        env: sideEnv(),
        stdin: new TextEncoder().encode(prompt),
        stdout: "pipe",
        stderr: "ignore",
      },
    );

    const timer = setTimeout(() => child.kill("SIGKILL"), SIDE_TIMEOUT_MS);
    const events = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(timer);

    const usage = events
      .split("\n")
      .flatMap((row) => {
        try {
          const event = JSON.parse(row);
          return event.type === "turn.completed" ? [event.usage] : [];
        } catch {
          return [];
        }
      })
      .at(-1);

    return { text: await readFile(out, "utf8").catch(() => ""), usage };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function onToolUsed(input: HookInput): Promise<void> {
  const due = await updateState((state) => {
    const entry = session(state, input.session_id);

    if (entry.turnId !== input.turn_id) {
      entry.turnId = input.turn_id;
      entry.step = 0;
    }

    entry.step += 1;
    return !entry.off && isCheckStep(entry.step, checkEvery(process.env.YSK_CHECK_EVERY)) && !takeSkip(state);
  });

  if (!due) return;

  await withCheckLock(input.session_id, async () => {
    const state = await readState();
    const { text, usage } = await sideCall(input, observerPrompt(state.seen, state.known));
    const reply = parseReply(text);
    await debugLog({ harness: "codex", outcome: reply.kind, usage });
    if (reply.kind !== "line") return;

    const shown = await updateState((fresh) => {
      const entry = session(fresh, input.session_id);
      if (entry.off || isRepeat(fresh, reply.line)) return false;

      markSeen(fresh, reply.line);
      entry.offer = {
        tag: reply.tag,
        line: reply.line,
        explanation: reply.explanation,
        shownAt: Date.now(),
        promptsSurvived: 0,
        explained: true,
      };
      return true;
    });

    if (!shown) return;

    const note = [
      `${reply.tag} · ${reply.line}`,
      "",
      reply.explanation,
      "",
      'Send "ysk known" if you knew this, or "ysk off" to stop these notes for this session.',
    ].join("\n");

    console.log(JSON.stringify({ systemMessage: note }));
  });
}

async function onPrompt(input: HookInput): Promise<void> {
  const command = input.prompt?.trim().toLowerCase();
  if (command !== "ysk known" && command !== "ysk off") return;

  const message = await updateState((state) => {
    const entry = session(state, input.session_id);
    noteAnswered(state);

    if (command === "ysk off") {
      entry.off = true;
      return "You should know is off for this session.";
    }

    if (entry.offer === undefined) return "There is no You should know note to mark.";
    markKnown(state, entry.offer.line);
    delete entry.offer;
    return "Noted, that topic will not come up again.";
  });

  console.log(JSON.stringify({ decision: "block", reason: message, systemMessage: message }));
}

const input: HookInput = JSON.parse(await new Response(Bun.stdin.stream()).text());
const side = process.env[SIDE_ENV] !== undefined;

if (input.hook_event_name === "PreToolUse" && side) stopSideCall();
if (input.hook_event_name === "PostToolUse" && !side) await onToolUsed(input);
if (input.hook_event_name === "UserPromptSubmit" && !side) await onPrompt(input);
