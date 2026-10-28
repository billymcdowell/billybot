import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { SubagentRun } from "./storage";
import { textOf } from "./text";

type Msg = ChatCompletionMessageParam;

// ---------- Where a chat stands ----------

export const stepLimitText = (steps: number) => `Stopped after ${steps} steps.`;
export const isStepLimitMessage = (m: Msg | undefined) =>
  m?.role === "assistant" && /^Stopped after \d+ steps\.$/.test(textOf(m.content));

export const budgetText = (cap: number) => `Stopped: this chat reached its budget of $${cap.toFixed(2)}.`;
export const isBudgetMessage = (m: Msg | undefined) =>
  m?.role === "assistant" && /^Stopped: this chat reached its budget of \$[\d.]+\.$/.test(textOf(m.content));

/**
 * - none: nothing said yet
 * - done: the agent finished and answered
 * - stopped: the user pressed Stop
 * - limit: the agent ran out of steps
 * - budget: the chat reached its spending cap
 * - unfinished: the last run ended without an answer (an error, or the app closed)
 */
export type RunState = "none" | "done" | "stopped" | "limit" | "budget" | "unfinished";

export function runState(messages: Msg[], stopped = false): RunState {
  const last = messages[messages.length - 1];
  if (!last) return "none";
  if (stopped) return "stopped";
  if (last.role === "assistant" && !last.tool_calls?.length) {
    return isStepLimitMessage(last) ? "limit" : isBudgetMessage(last) ? "budget" : "done";
  }
  return "unfinished";
}

// ---------- Repairing a chat that was cut off ----------

export const INTERRUPTED_RESULT = "Interrupted: the app closed before this finished.";

/**
 * The API rejects a conversation where a tool call has no result, or a result has no call.
 * Closing the app mid-run can leave both. This answers each unanswered call and drops
 * orphaned results, and says whether it had to.
 */
export function repairMessages(messages: Msg[]): { messages: Msg[]; repaired: boolean } {
  const out: Msg[] = [];
  let repaired = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      repaired = true; // not directly after its assistant message: nothing to attach it to
      continue;
    }
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;

    const ids = new Set(m.tool_calls.map((c) => c.id));
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const result = messages[j] as Extract<Msg, { role: "tool" }>;
      if (ids.has(result.tool_call_id) && !answered.has(result.tool_call_id)) {
        out.push(result);
        answered.add(result.tool_call_id);
      } else {
        repaired = true;
      }
      j++;
    }
    for (const id of ids) {
      if (answered.has(id)) continue;
      out.push({ role: "tool", tool_call_id: id, content: INTERRUPTED_RESULT });
      repaired = true;
    }
    i = j - 1;
  }
  return { messages: out, repaired };
}

/** A subagent still marked "running" in a saved chat can't be: its run ended with the app. */
export function repairSubagents(subagents: Record<string, SubagentRun>): {
  subagents: Record<string, SubagentRun>;
  repaired: boolean;
} {
  let repaired = false;
  const out: Record<string, SubagentRun> = {};
  for (const [id, run] of Object.entries(subagents)) {
    if (run.status === "running") {
      repaired = true;
      out[id] = { ...run, status: "stopped", report: run.report ?? "Interrupted: the app closed before this finished." };
    } else {
      out[id] = run;
    }
  }
  return { subagents: out, repaired };
}

// ---------- Forking ----------

/**
 * The messages up to and including `upTo`, ready to start a new chat from. If that message
 * is an assistant message that called tools, the tool results come with it.
 */
export function forkMessages(messages: Msg[], upTo: number): Msg[] {
  const last = Math.min(upTo, messages.length - 1);
  let end = last + 1;
  if (messages[last]?.role === "assistant") {
    while (end < messages.length && messages[end].role === "tool") end++;
  }
  return repairMessages(messages.slice(0, end)).messages;
}

// ---------- Titles and search ----------

/** The chat's name until the user picks one: the start of the first message. */
export function autoTitle(messages: Msg[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = textOf(first?.content).replace(/\s+/g, " ").trim();
  return text.slice(0, 40) || "New chat";
}

/** What a person said and what the agent answered, without tool results, for searching. */
export function searchableText(messages: Msg[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n");
}

/** A short piece of `text` around the first match of `query`, or null if it doesn't contain it. */
export function snippetAround(text: string, query: string, radius = 40): string | null {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return null;
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + query.length + radius);
  const piece = text.slice(from, to).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + piece + (to < text.length ? "…" : "");
}
