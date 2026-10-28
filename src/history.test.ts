import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import {
  autoTitle, INTERRUPTED_RESULT, isStepLimitMessage, repairMessages, repairSubagents, runState,
  searchableText, snippetAround, stepLimitText,
} from "./history";

const user = (content: string): Msg => ({ role: "user", content });
const reply = (content: string): Msg => ({ role: "assistant", content });
const calls = (...ids: string[]): Msg => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({ id, type: "function" as const, function: { name: "list_dir", arguments: "{}" } })),
});
const result = (id: string, content = "ok"): Msg => ({ role: "tool", tool_call_id: id, content });

describe("repairMessages", () => {
  it("leaves a complete conversation alone", () => {
    const msgs = [user("hi"), calls("a", "b"), result("a"), result("b"), reply("done")];
    const out = repairMessages(msgs);
    expect(out.repaired).toBe(false);
    expect(out.messages).toEqual(msgs);
  });

  it("answers a tool call that never got a result", () => {
    const out = repairMessages([user("hi"), calls("a")]);
    expect(out.repaired).toBe(true);
    expect(out.messages).toEqual([user("hi"), calls("a"), result("a", INTERRUPTED_RESULT)]);
  });

  it("answers only the missing calls and keeps the results that exist, in place", () => {
    const out = repairMessages([user("hi"), calls("a", "b", "c"), result("b", "B")]);
    expect(out.messages).toEqual([
      user("hi"), calls("a", "b", "c"), result("b", "B"), result("a", INTERRUPTED_RESULT), result("c", INTERRUPTED_RESULT),
    ]);
  });

  it("repairs every broken turn, not just the last", () => {
    const out = repairMessages([user("1"), calls("a"), user("2"), calls("b")]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
  });

  it("drops results that belong to no call, and duplicate results", () => {
    const out = repairMessages([user("hi"), result("ghost"), calls("a"), result("a"), result("a", "again"), result("zzz"), reply("x")]);
    expect(out.repaired).toBe(true);
    expect(out.messages).toEqual([user("hi"), calls("a"), result("a"), reply("x")]);
  });

  it("handles an empty chat", () => {
    expect(repairMessages([])).toEqual({ messages: [], repaired: false });
  });
});

describe("repairSubagents", () => {
  const run = (status: "running" | "done") => ({ project: "p", task: "t", status, messages: [] });
  it("marks a run that was in progress as stopped", () => {
    const out = repairSubagents({ a: run("running"), b: run("done") });
    expect(out.repaired).toBe(true);
    expect(out.subagents.a).toMatchObject({ status: "stopped", report: expect.stringContaining("Interrupted") });
    expect(out.subagents.b.status).toBe("done");
  });
  it("changes nothing otherwise", () => {
    expect(repairSubagents({ b: run("done") }).repaired).toBe(false);
  });
});

describe("runState", () => {
  it("tells where a chat stands", () => {
    expect(runState([])).toBe("none");
    expect(runState([user("hi"), reply("hello")])).toBe("done");
    expect(runState([user("hi"), reply(stepLimitText(25))])).toBe("limit");
    expect(runState([user("hi")])).toBe("unfinished");
    expect(runState([user("hi"), calls("a"), result("a")])).toBe("unfinished");
    expect(runState([user("hi"), calls("a")])).toBe("unfinished");
  });
  it("a Stop wins over everything else", () => {
    expect(runState([user("hi"), reply("par")], true)).toBe("stopped");
    expect(runState([user("hi")], true)).toBe("stopped");
  });
  it("recognises only the real step-limit message", () => {
    expect(isStepLimitMessage(reply("Stopped after 25 steps."))).toBe(true);
    expect(isStepLimitMessage(reply("I Stopped after 25 steps. then more"))).toBe(false);
    expect(isStepLimitMessage(user("Stopped after 25 steps."))).toBe(false);
  });
});

describe("autoTitle", () => {
  it("uses the start of the first user message, on one line", () => {
    expect(autoTitle([reply("x"), user("  fix\nthe   login bug  ")])).toBe("fix the login bug");
    expect(autoTitle([user("a".repeat(100))])).toHaveLength(40);
  });
  it("falls back for an empty chat", () => {
    expect(autoTitle([])).toBe("New chat");
    expect(autoTitle([user("   ")])).toBe("New chat");
  });
});

describe("searching", () => {
  const msgs = [user("Where is the Login form?"), calls("a"), result("a", "secret-tool-output"), reply("It is in src/Login.tsx")];
  it("covers what was said, not tool output", () => {
    const text = searchableText(msgs);
    expect(text).toContain("Login form");
    expect(text).toContain("src/Login.tsx");
    expect(text).not.toContain("secret-tool-output");
  });
  it("finds a match ignoring case and shows what is around it", () => {
    expect(snippetAround("Where is the Login form?", "login", 5)).toBe("…the Login form…");
    expect(snippetAround("short", "short")).toBe("short");
    expect(snippetAround("nothing here", "zzz")).toBeNull();
  });
});
