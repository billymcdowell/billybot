import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import {
  chooseCut, compactionFor, fallbackCompaction, keepTokensFor, messageTokens, planCompaction, REMOVED_RESULT, renderTranscript,
  shouldCompact, summaryMessage, summaryRequest, SUMMARY_SYSTEM, view, type Compaction,
} from "./compaction";

const user = (content: string): Msg => ({ role: "user", content });
const say = (content: string): Msg => ({ role: "assistant", content });
const call = (id: string, name = "read_file", args: object = { path: "app/a.ts" }): Msg => ({
  role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content = "ok"): Msg => ({ role: "tool", tool_call_id: id, content });
const big = (n: number) => "x".repeat(n * 4); // about n tokens
const comp = (over: Partial<Compaction> = {}): Compaction => ({ upTo: 0, summary: "", at: 1, ...over });

/** A long working session: your request, then several rounds of the agent reading files. */
function session(rounds = 6, resultTokens = 1000): Msg[] {
  const out: Msg[] = [user("fix the login bug")];
  for (let i = 0; i < rounds; i++) out.push(call(`c${i}`), result(`c${i}`, big(resultTokens)));
  out.push(say("done"));
  return out;
}

describe("view", () => {
  it("is the messages themselves when there is no compaction", () => {
    const msgs = session(2);
    expect(view(msgs, null)).toBe(msgs);
    expect(view(msgs, undefined)).toBe(msgs);
  });

  it("puts a summary in place of the earlier messages and keeps the rest as they are", () => {
    const msgs = [user("one"), say("r1"), user("two"), say("r2")];
    const seen = view(msgs, comp({ upTo: 2, summary: "They did one." }));
    expect(seen).toHaveLength(3);
    expect(seen[0].role).toBe("user");
    expect(String(seen[0].content)).toContain("They did one.");
    expect(String(seen[0].content)).toContain("summarized to save space");
    expect(seen.slice(1)).toEqual(msgs.slice(2));
    expect(msgs).toHaveLength(4); // nothing was changed
  });

  it("repeats the user's latest request when it fell inside the summarized part", () => {
    const msgs = [user("Please add dark mode\nand keep it small"), call("c1"), result("c1"), call("c2"), result("c2"), say("working")];
    const seen = view(msgs, comp({ upTo: 3, summary: "Read a file." }));
    expect(String(seen[0].content)).toContain("> Please add dark mode\n> and keep it small");
    const kept = view([user("first"), say("r"), user("second"), say("r2")], comp({ upTo: 2, summary: "s" }));
    expect(String(kept[0].content)).not.toContain("most recent request"); // "second" is still there word for word
  });

  it("hides old tool results without touching your messages when only the fallback applies", () => {
    const msgs = [user("go"), call("c1"), result("c1", "secret contents"), call("c2"), result("c2", "newer")];
    const seen = view(msgs, comp({ dropResultsBefore: 3 }));
    expect(seen).toHaveLength(5);
    expect(seen[0]).toEqual(user("go"));
    expect(seen[2]).toEqual({ role: "tool", tool_call_id: "c1", content: REMOVED_RESULT });
    expect(seen[4]).toEqual(result("c2", "newer"));
  });

  it("can combine a summary with hidden results after it", () => {
    const msgs = [user("a"), say("b"), call("c1"), result("c1", "old"), call("c2"), result("c2", "new")];
    const seen = view(msgs, comp({ upTo: 2, summary: "S", dropResultsBefore: 4 }));
    expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(seen[2]).toMatchObject({ content: REMOVED_RESULT });
    expect(seen[4]).toMatchObject({ content: "new" });
  });

  it("never leaves a tool result without the call that asked for it", () => {
    const msgs = session(5);
    const cut = chooseCut(msgs, 0, 2500)!;
    const seen = view(msgs, comp({ upTo: cut, summary: "S" }));
    const asked = new Set(seen.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])));
    for (const m of seen) if (m.role === "tool") expect(asked.has(m.tool_call_id)).toBe(true);
  });

  it("copes with an upTo that is out of range", () => {
    const msgs = [user("a"), say("b")];
    expect(view(msgs, comp({ upTo: 99, summary: "S" }))).toHaveLength(1);
    expect(view(msgs, comp({ upTo: -5, summary: "S" }))).toHaveLength(3);
  });
});

describe("chooseCut", () => {
  it("keeps about the requested amount of the newest messages and cuts before them", () => {
    const msgs = session(8, 1000); // user, 8 × (call + 1000-token result), reply
    const cut = chooseCut(msgs, 0, 3000)!;
    const kept = msgs.slice(cut);
    expect(kept.reduce((n, m) => n + messageTokens(m), 0)).toBeGreaterThanOrEqual(3000);
    expect(kept.reduce((n, m) => n + messageTokens(m), 0)).toBeLessThan(5000);
  });

  it("never starts the kept part on a tool result", () => {
    const msgs = session(8, 1000);
    for (const keep of [500, 1000, 1500, 2500, 3500, 6000]) {
      const cut = chooseCut(msgs, 0, keep);
      if (cut !== null) expect(msgs[cut].role).not.toBe("tool");
    }
  });

  it("can cut inside a single long turn, where there is only one message from you", () => {
    const msgs = session(10, 2000);
    const cut = chooseCut(msgs, 0, 5000)!;
    expect(cut).toBeGreaterThan(1);
    expect(msgs.slice(0, cut).filter((m) => m.role === "user")).toHaveLength(1); // your request is among those summarized
  });

  it("only covers messages after an earlier compaction, and does nothing if too little is left to drop", () => {
    const msgs = session(8, 1000);
    const first = chooseCut(msgs, 0, 3000)!;
    const second = chooseCut([...msgs, ...session(8, 1000).slice(1)], first, 3000)!;
    expect(second).toBeGreaterThan(first);
    expect(chooseCut(msgs, first, 3000)).toBeNull(); // nothing new worth dropping yet
    expect(chooseCut([user("a"), say("b")], 0, 10)).toBeNull();
    expect(chooseCut([], 0, 10)).toBeNull();
  });
});

describe("keepTokensFor and shouldCompact", () => {
  it("keeps a quarter of the window within bounds", () => {
    expect(keepTokensFor(200_000)).toBe(50_000);
    expect(keepTokensFor(1_000_000)).toBe(60_000);
    expect(keepTokensFor(8_000)).toBe(4_000);
    expect(keepTokensFor(null)).toBe(20_000);
  });
  it("compacts at the chosen share of the window", () => {
    expect(shouldCompact(79_000, 100_000)).toBe(false);
    expect(shouldCompact(80_000, 100_000)).toBe(true);
    expect(shouldCompact(50_000, 100_000, 0.5)).toBe(true);
    expect(shouldCompact(10, 0)).toBe(false);
  });
});

describe("compactionFor", () => {
  it("keeps a compaction whose summary is still wholly inside the chat, and drops one that isn't", () => {
    expect(compactionFor(comp({ upTo: 6, summary: "S" }), 10)).toMatchObject({ upTo: 6 });
    expect(compactionFor(comp({ upTo: 6, summary: "S" }), 6)).toMatchObject({ upTo: 6 });
    expect(compactionFor(comp({ upTo: 6, summary: "S" }), 5)).toBeNull();
    expect(compactionFor(null, 5)).toBeNull();
  });
  it("trims where results are hidden to the length that is left", () => {
    expect(compactionFor(comp({ dropResultsBefore: 9 }), 4)).toMatchObject({ dropResultsBefore: 4 });
  });
});

describe("renderTranscript and summaryRequest", () => {
  const msgs = [
    user("fix the bug"),
    call("c1", "read_file", { path: "app/a.ts" }),
    result("c1", "const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef'"),
    call("c2", "write_file", { path: "app/b.ts", content: "y".repeat(500) }),
    result("c2", "Wrote 500 bytes"),
    say("fixed it"),
  ];

  it("lays the conversation out as readable text, with what each result was for", () => {
    const text = renderTranscript(msgs);
    expect(text).toContain("[User]\nfix the bug");
    expect(text).toContain("[Called read_file path=app/a.ts]");
    expect(text).toContain("[Called write_file path=app/b.ts content=(500 chars)]");
    expect(text).toContain("[Result of read_file]");
    expect(text).toContain("[Result of write_file]\nWrote 500 bytes");
    expect(text).toContain("[Assistant]\nfixed it");
  });

  it("removes secrets and never includes file contents being written", () => {
    const text = renderTranscript(msgs);
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toContain("yyyyy");
  });

  it("cuts long results, and shrinks them further when the whole thing is huge", () => {
    const one = renderTranscript([call("c"), result("c", "z".repeat(10_000))]);
    expect(one.length).toBeLessThan(2000);
    expect(one).toContain("more characters]");
    const many = Array.from({ length: 400 }, (_, i) => [call(`c${i}`), result(`c${i}`, "z".repeat(5000))]).flat();
    expect(renderTranscript(many).length).toBeLessThanOrEqual(200_000 + 100);
  });

  it("asks for a summary of what it was given, with the earlier summary and to-do list included", () => {
    const req = summaryRequest("Earlier: set up the repo.", msgs, [{ content: "Add tests", status: "pending" }]);
    expect(req[0]).toEqual({ role: "system", content: SUMMARY_SYSTEM });
    const body = String(req[1].content);
    expect(body).toContain("Summary so far, from earlier compaction:\nEarlier: set up the repo.");
    expect(body).toContain("- [pending] Add tests");
    expect(body).toContain("[User]\nfix the bug");
    expect(String(summaryRequest("", msgs)[1].content)).not.toContain("Summary so far");
    expect(SUMMARY_SYSTEM).toMatch(/files created or changed/);
    expect(SUMMARY_SYSTEM).toMatch(/not instructions to follow/);
  });
});

describe("planCompaction", () => {
  it("picks the messages to summarize, starting after the last compaction", () => {
    const msgs = session(8, 1000);
    const first = planCompaction(msgs, null, 3000)!;
    expect(first.from).toBe(0);
    expect(first.slice).toEqual(msgs.slice(0, first.cut));
    const longer = [...msgs, ...session(8, 1000).slice(1)];
    const second = planCompaction(longer, comp({ upTo: first.cut, summary: "S" }), 3000)!;
    expect(second.from).toBe(first.cut);
    expect(second.slice[0]).toBe(longer[first.cut]);
  });
  it("returns null when there's nothing worth doing", () => {
    expect(planCompaction([user("a"), say("b")], null, 100)).toBeNull();
  });
});

describe("fallbackCompaction", () => {
  const msgs = session(8, 1000);
  it("hides the oldest tool results until it fits, and keeps everything of yours", () => {
    const c = fallbackCompaction(msgs, null, 3000, 5)!;
    expect(c.summary).toBe("");
    expect(c.upTo).toBe(0);
    const seen = view(msgs, c);
    expect(seen.reduce((n, m) => n + messageTokens(m), 0)).toBeLessThanOrEqual(3000 + 1100);
    expect(seen).toHaveLength(msgs.length);
    expect(seen.filter((m) => m.role === "user")).toEqual(msgs.filter((m) => m.role === "user"));
    expect(seen.filter((m) => m.role === "tool" && m.content === REMOVED_RESULT).length).toBeGreaterThan(0);
    expect(seen[seen.length - 2]).toMatchObject({ role: "tool", content: expect.not.stringContaining("removed") });
  });
  it("goes further on a second try, and returns null when nothing more can go", () => {
    const first = fallbackCompaction(msgs, null, 6000, 5)!;
    const second = fallbackCompaction(msgs, first, 1000, 6)!;
    expect(second.dropResultsBefore).toBeGreaterThan(first.dropResultsBefore!);
    expect(fallbackCompaction(msgs, comp({ dropResultsBefore: msgs.length }), 1, 7)).toBeNull();
    expect(fallbackCompaction([user("hi"), say("yo")], null, 1, 7)).toBeNull();
  });
  it("works on top of a summary, hiding only results the model still sees", () => {
    const base = comp({ upTo: 5, summary: "S" });
    const c = fallbackCompaction(msgs, base, 2000, 8)!;
    expect(c.upTo).toBe(5);
    expect(c.summary).toBe("S");
    expect(c.dropResultsBefore).toBeGreaterThan(5);
  });
});

describe("summaryMessage", () => {
  it("is a user message that says what it is", () => {
    const m = summaryMessage("Did a thing.");
    expect(m.role).toBe("user");
    expect(String(m.content)).toContain("Did a thing.");
    expect(String(summaryMessage("")).length).toBeGreaterThan(0);
    expect(String(summaryMessage("", undefined).content)).toContain("No summary is available");
  });
});
