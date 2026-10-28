import { describe, expect, it } from "vitest";
import {
  activityStats, filterEvents, formatDuration, makeEvent, mergeEvents, parseLines, summarizeArgs, toJsonLines, upsertEvent,
  type ActivityDraft, type ActivityEvent,
} from "./activity";

let n = 0;
const ev = (draft: Partial<ActivityDraft> & { summary?: string } = {}, time = 1000, chatId = "c1"): ActivityEvent =>
  makeEvent({ category: "tool", summary: "something", ...draft }, chatId, time, `id${++n}`);

describe("makeEvent", () => {
  it("fills in defaults", () => {
    const e = ev();
    expect(e).toMatchObject({ level: "info", who: "Main agent", depth: 0, chatId: "c1", time: 1000 });
  });

  it("removes secrets from the summary and the details", () => {
    const e = ev({ summary: "ran sk-or-v1-0123456789abcdef0123456789abcdef", detail: { out: "TOKEN=abc", nested: { k: ["AKIAIOSFODNN7EXAMPLE"] } } });
    expect(JSON.stringify(e)).not.toMatch(/0123456789abcdef|TOKEN=abc|AKIAIOSFODNN7/);
    expect(e.summary).toContain("[REDACTED:api-key]");
  });

  it("clips very long text and very long lists", () => {
    const e = ev({ summary: "x".repeat(1000), detail: { big: "y".repeat(5000), list: Array.from({ length: 200 }, (_, i) => i) } });
    expect(e.summary.length).toBeLessThan(310);
    expect(String(e.detail!.big).length).toBeLessThan(1600);
    expect(String(e.detail!.big)).toContain("more characters");
    expect((e.detail!.list as number[]).length).toBe(50);
  });
});

describe("upsertEvent", () => {
  it("appends events without a ref", () => {
    const list = upsertEvent(upsertEvent([], ev()), ev());
    expect(list).toHaveLength(2);
  });

  it("turns a running row into its finished row, keeping its place, start time and id", () => {
    const start = ev({ ref: "t1", pending: true, summary: "read_file a" }, 1000);
    const other = ev({ summary: "later" }, 1500);
    const done = ev({ ref: "t1", summary: "read_file a → ok" }, 1800);
    const list = upsertEvent(upsertEvent(upsertEvent([], start), other), done);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: start.id, time: 1000, summary: "read_file a → ok", durationMs: 800 });
    expect(list[0].pending).toBeFalsy();
  });

  it("keeps a duration the event brings itself", () => {
    const list = upsertEvent(upsertEvent([], ev({ ref: "r", pending: true }, 0)), ev({ ref: "r", durationMs: 42 }, 5000));
    expect(list[0].durationMs).toBe(42);
  });

  it("does not mix up the same ref in different chats", () => {
    const list = upsertEvent(upsertEvent([], ev({ ref: "r" }, 1, "a")), ev({ ref: "r" }, 2, "b"));
    expect(list).toHaveLength(2);
  });

  it("drops the oldest events past the cap", () => {
    let list: ActivityEvent[] = [];
    for (let i = 0; i < 12; i++) list = upsertEvent(list, ev({ summary: `e${i}` }), 10);
    expect(list).toHaveLength(10);
    expect(list[0].summary).toBe("e2");
  });
});

describe("summarizeArgs", () => {
  it("lists the arguments briefly and shows only the size of contents", () => {
    expect(summarizeArgs({ path: "app/a.ts", content: "x".repeat(2340) })).toBe("path=app/a.ts content=(2,340 chars)");
    expect(summarizeArgs({ edits: [{ old_text: "a", new_text: "b" }], task: "do it" })).toMatch(/^edits=\(\d+ chars\) task=\(5 chars\)$/);
    expect(summarizeArgs({ command: "x".repeat(100) })).toBe(`command=${"x".repeat(60)}…`);
    expect(summarizeArgs({ a: 1, b: true, c: ["x"] })).toBe('a=1 b=true c=["x"]');
  });
  it("caps the whole line and copes with odd input", () => {
    expect(summarizeArgs({ a: "x".repeat(50), b: "y".repeat(50), c: "z".repeat(50) }).length).toBeLessThanOrEqual(141);
    expect(summarizeArgs(null)).toBe("");
    expect(summarizeArgs("text")).toBe("");
  });
});

describe("filterEvents", () => {
  const list = [
    ev({ category: "request", summary: "Asking model" }),
    ev({ category: "tool", summary: "read_file app/login.ts" }),
    ev({ category: "command", summary: "run_command npm test", level: "warn" }),
    ev({ category: "approval", summary: "You approved" }),
    ev({ category: "subagent", summary: "Subagent for app" }),
    ev({ category: "tool", summary: "grep inside", depth: 1, who: "app agent" }),
    ev({ category: "error", summary: "boom", level: "error" }),
  ];
  it("shows everything with no filter and no search", () => {
    expect(filterEvents(list, new Set(), "")).toHaveLength(7);
  });
  it("filters by chip, and a chip can match several kinds", () => {
    expect(filterEvents(list, new Set(["requests"]), "")).toHaveLength(1);
    expect(filterEvents(list, new Set(["tools"]), "").map((e) => e.category)).toEqual(["tool", "command", "tool"]);
    expect(filterEvents(list, new Set(["approvals"]), "")).toHaveLength(1);
    expect(filterEvents(list, new Set(["subagents"]), "").map((e) => e.summary)).toEqual(["Subagent for app", "grep inside"]);
    expect(filterEvents(list, new Set(["problems"]), "").map((e) => e.summary)).toEqual(["run_command npm test", "boom"]);
    expect(filterEvents(list, new Set(["requests", "approvals"]), "")).toHaveLength(2);
  });
  it("searches the summary, the agent and the details, ignoring case", () => {
    expect(filterEvents(list, new Set(), "LOGIN")).toHaveLength(1);
    expect(filterEvents(list, new Set(), "app agent")).toHaveLength(1);
    const withDetail = [ev({ summary: "x", detail: { preview: "needle here" } })];
    expect(filterEvents(withDetail, new Set(), "needle")).toHaveLength(1);
    expect(filterEvents(list, new Set(["tools"]), "login")).toHaveLength(1);
    expect(filterEvents(list, new Set(["requests"]), "login")).toHaveLength(0);
  });
});

describe("activityStats", () => {
  it("totals requests, tool calls, problems, tokens, cost and elapsed time", () => {
    const list = [
      ev({ category: "request", detail: { inputTokens: 100, outputTokens: 10, cost: 0.01 } }, 1000),
      ev({ category: "request", pending: true, detail: { inputTokens: 5 } }, 1500),
      ev({ category: "tool" }, 2000),
      ev({ category: "command", level: "warn" }, 3000),
      ev({ category: "request", level: "error" }, 4500),
      ev({ category: "request", detail: { inputTokens: 200, outputTokens: 20 } }, 6000),
    ];
    expect(activityStats(list)).toEqual({ requests: 2, toolCalls: 2, problems: 2, inputTokens: 300, outputTokens: 30, cost: 0.01, elapsedMs: 5000 });
    expect(activityStats([]).elapsedMs).toBe(0);
  });
});

describe("saving and loading", () => {
  it("round-trips through JSON lines", () => {
    const list = [ev({ detail: { a: 1 } }), ev({ category: "approval", level: "warn" })];
    expect(parseLines(toJsonLines(list).split("\n"))).toEqual(list);
  });
  it("skips damaged lines and events it doesn't recognise", () => {
    const good = ev();
    const lines = ["{nope", "", JSON.stringify({ id: 1 }), JSON.stringify({ ...good, category: "weird" }), JSON.stringify(good)];
    expect(parseLines(lines)).toEqual([good]);
  });
  it("fills in fields an older line is missing", () => {
    const { level: _l, who: _w, depth: _d, ...bare } = ev();
    expect(parseLines([JSON.stringify(bare)])[0]).toMatchObject({ level: "info", who: "Main agent", depth: 0 });
  });
  it("merges saved and current events, once each, oldest first", () => {
    const a = ev({}, 100);
    const b = ev({}, 300);
    const stale = { ...b, summary: "old version" };
    const c = ev({}, 200);
    const merged = mergeEvents([a, stale], [b, c]);
    expect(merged.map((e) => e.id)).toEqual([a.id, c.id, b.id]);
    expect(merged[2].summary).toBe(b.summary);
    expect(mergeEvents([], [])).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("is short and readable", () => {
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(15_600)).toBe("16 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });
});
