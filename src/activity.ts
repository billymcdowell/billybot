// The activity log: a stream of events describing what the app and the agent are doing. The
// panel on the right shows it live, and the same events are saved to the audit log on disk.
//
// Everything in an event is redacted and clipped before it is kept, so the log is safe to show,
// save and export. File contents are never logged; only paths, sizes and short previews.

import { redactDeep } from "./redact";

export type ActivityCategory = "run" | "request" | "tool" | "command" | "approval" | "subagent" | "chat" | "error";
export type ActivityLevel = "info" | "warn" | "error";

/** What the code that raises an event supplies. */
export type ActivityDraft = {
  category: ActivityCategory;
  level?: ActivityLevel;
  who?: string; // "Main agent", or "app agent" for a subagent
  depth?: number; // 1 for events from inside a subagent
  summary: string; // one line
  detail?: Record<string, unknown>;
  /** Two events with the same ref are one row: the later one (finished) replaces the earlier (running). */
  ref?: string;
  /** Still going. Pending events are shown live but not saved. */
  pending?: boolean;
  durationMs?: number;
};

export type ActivityEvent = Required<Pick<ActivityDraft, "category" | "level" | "summary" | "who" | "depth">> &
  Pick<ActivityDraft, "detail" | "ref" | "pending" | "durationMs"> & {
    id: string;
    time: number; // when it started, in milliseconds since 1970
    chatId: string;
  };

export const MAX_EVENTS = 2000;
const MAX_STRING = 1500;

/** Cuts long strings anywhere in a value, saying how much was left out. */
function clipDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${(value.length - MAX_STRING).toLocaleString("en-US")} more characters)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(clipDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipDeep(v)]));
  }
  return value;
}

export function makeEvent(draft: ActivityDraft, chatId: string, now = Date.now(), id: string = crypto.randomUUID()): ActivityEvent {
  const clean = redactDeep({ summary: draft.summary, detail: draft.detail });
  return {
    id,
    time: now,
    chatId,
    category: draft.category,
    level: draft.level ?? "info",
    who: draft.who ?? "Main agent",
    depth: draft.depth ?? 0,
    summary: clean.summary.length > 300 ? `${clean.summary.slice(0, 300)}…` : clean.summary,
    detail: clean.detail ? (clipDeep(clean.detail) as Record<string, unknown>) : undefined,
    ref: draft.ref,
    pending: draft.pending,
    durationMs: draft.durationMs,
  };
}

/**
 * Adds an event, or, if one with the same ref is already there, replaces it in place (keeping
 * where and when it started and working out how long it took). Keeps at most `cap` events.
 */
export function upsertEvent(list: ActivityEvent[], event: ActivityEvent, cap = MAX_EVENTS): ActivityEvent[] {
  const at = event.ref ? list.findIndex((e) => e.ref === event.ref && e.chatId === event.chatId) : -1;
  let next: ActivityEvent[];
  if (at === -1) {
    next = [...list, event];
  } else {
    const started = list[at];
    const merged: ActivityEvent = {
      ...event,
      id: started.id,
      time: started.time,
      durationMs: event.durationMs ?? (event.pending ? undefined : Math.max(0, event.time - started.time)),
    };
    next = list.slice();
    next[at] = merged;
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ---------- Describing calls ----------

// Arguments that can be large or private: only their size is shown.
const SIZE_ONLY = new Set(["content", "old_text", "new_text", "edits", "task"]);

/** `path=app/a.ts content=(2,340 chars)`: what a tool was asked, without the contents. */
export function summarizeArgs(args: unknown, max = 140): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    if (SIZE_ONLY.has(k)) {
      const size = typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
      return `${k}=(${size.toLocaleString("en-US")} chars)`;
    }
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
  });
  const line = parts.join(" ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---------- Looking at a list of events ----------

export type Filter = "requests" | "tools" | "approvals" | "subagents" | "problems";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "tools", label: "Tools" },
  { id: "approvals", label: "Approvals" },
  { id: "subagents", label: "Subagents" },
  { id: "problems", label: "Problems" },
];

const matchesFilter = (e: ActivityEvent, f: Filter) => {
  switch (f) {
    case "requests": return e.category === "request" || e.category === "run";
    case "tools": return e.category === "tool" || e.category === "command";
    case "approvals": return e.category === "approval";
    case "subagents": return e.category === "subagent" || e.depth > 0;
    case "problems": return e.level !== "info";
  }
};

/** Events that match any chosen filter (all of them if none is chosen) and contain the search text. */
export function filterEvents(list: ActivityEvent[], active: Set<Filter>, query: string): ActivityEvent[] {
  const q = query.trim().toLowerCase();
  return list.filter((e) => {
    if (active.size > 0 && ![...active].some((f) => matchesFilter(e, f))) return false;
    if (!q) return true;
    return `${e.summary} ${e.who} ${e.detail ? JSON.stringify(e.detail) : ""}`.toLowerCase().includes(q);
  });
}

export type ActivityStats = {
  requests: number;
  toolCalls: number;
  problems: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  elapsedMs: number;
};

export function activityStats(list: ActivityEvent[]): ActivityStats {
  const stats: ActivityStats = { requests: 0, toolCalls: 0, problems: 0, inputTokens: 0, outputTokens: 0, cost: 0, elapsedMs: 0 };
  for (const e of list) {
    if (e.level !== "info") stats.problems++;
    if (e.category === "tool" || e.category === "command") stats.toolCalls++;
    if (e.category === "request" && !e.pending && typeof e.detail?.inputTokens === "number") {
      stats.requests++;
      stats.inputTokens += e.detail.inputTokens;
      stats.outputTokens += typeof e.detail.outputTokens === "number" ? e.detail.outputTokens : 0;
      stats.cost += typeof e.detail.cost === "number" ? e.detail.cost : 0;
    }
  }
  if (list.length > 1) stats.elapsedMs = list[list.length - 1].time - list[0].time;
  return stats;
}

// ---------- Saving and loading ----------

/** One JSON object per line, for the audit log and for export. */
export const toJsonLines = (list: ActivityEvent[]) => list.map((e) => JSON.stringify(e)).join("\n");

const CATEGORIES = new Set<string>(["run", "request", "tool", "command", "approval", "subagent", "chat", "error"]);

/** Reads saved lines back, skipping any that are damaged. */
export function parseLines(lines: string[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.id === "string" && typeof e.time === "number" && typeof e.chatId === "string" && CATEGORIES.has(e.category) && typeof e.summary === "string") {
        out.push({ level: "info", who: "Main agent", depth: 0, ...e });
      }
    } catch {
      // a damaged line: skip it
    }
  }
  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Saved events plus the ones already on screen, each once, oldest first. */
export function mergeEvents(saved: ActivityEvent[], current: ActivityEvent[], cap = MAX_EVENTS): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const e of saved) byId.set(e.id, e);
  for (const e of current) byId.set(e.id, e); // what is on screen is newer
  const all = [...byId.values()].sort((a, b) => a.time - b.time);
  return all.length > cap ? all.slice(all.length - cap) : all;
}
