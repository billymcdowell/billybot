import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { DEFAULT_LIMITS } from "./limits";
import type { ActivityEvent } from "./activity";
import type { Conversation, Mode } from "./storage";
import type { AgentOptions } from "./tools/types";
import { INTERRUPTED_RESULT } from "./history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./storage", () => ({ getAlwaysAllowed: async () => [], addAlwaysAllowed: async () => {} }));

import { actedIn, createController, isBusy, SessionStore, titleOf, type Deps } from "./sessions";

const lastOf = <T,>(a: T[]) => a[a.length - 1];
const flush = () => new Promise((r) => setTimeout(r, 0));
const user = (content: string): Msg => ({ role: "user", content });
const reply = (content: string): Msg => ({ role: "assistant", content });

/** A stand-in for the agent loop that stays "working" until the test says it is done, and returns when stopped, like the real one. */
function fakeAgent() {
  type Call = { opts: AgentOptions; finish: (extra?: Msg[]) => void; fail: (e: Error) => void; stopped: boolean };
  const calls: Call[] = [];
  let live = 0;
  let peak = 0;
  const runAgent = vi.fn(
    (opts: AgentOptions) =>
      new Promise<Msg[]>((resolve, reject) => {
        live++;
        peak = Math.max(peak, live);
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          live--;
          fn();
        };
        const call: Call = {
          opts, stopped: false,
          finish: (extra = [reply("done")]) => settle(() => resolve([...opts.messages, ...extra])),
          fail: (e) => settle(() => reject(e)),
        };
        opts.signal?.addEventListener("abort", () => settle(() => { call.stopped = true; resolve([...opts.messages]); }), { once: true });
        calls.push(call);
      }),
  );
  return { runAgent, calls, peak: () => peak };
}

function setup(over: Partial<Deps> = {}, limits = {}) {
  const agent = fakeAgent();
  const saved: { workspace: string; chat: Conversation }[] = [];
  const notified: string[][] = [];
  const cancelled: string[] = [];
  const audit: ActivityEvent[] = [];
  let n = 0;
  let clock = 1000;
  const ctl = createController({
    workspace: () => "/ws",
    apiKey: () => "key",
    model: () => "m",
    limits: () => ({ ...DEFAULT_LIMITS, ...limits }),
    runAgent: agent.runAgent,
    saveChat: async (workspace, chat) => void saved.push({ workspace, chat: JSON.parse(JSON.stringify(chat)) }),
    saveActivity: (e) => void audit.push(e),
    notify: (title, body) => void notified.push([title, body]),
    cancelCommands: (key) => void cancelled.push(key),
    now: () => ++clock,
    newId: () => `id${++n}`,
    ...over,
  });
  return { ctl, store: ctl.store, agent, saved, notified, cancelled, audit };
}

const chatsSaved = (saved: { chat: Conversation }[], id: string) => saved.filter((s) => s.chat.id === id).map((s) => s.chat);

afterEach(() => vi.useRealTimers());

describe("one chat", () => {
  it("sends a message, shows the agent's work as it happens, and saves at the start and the end", async () => {
    const { ctl, store, agent, saved } = setup();
    ctl.create("A");
    ctl.send("A", "  hello  ");
    expect(store.get("A")).toMatchObject({ phase: "waiting", draft: "", messages: [user("hello")] });
    await flush();
    expect(store.get("A")!.phase).toBe("running");
    expect(chatsSaved(saved, "A")[0].messages).toEqual([user("hello")]); // saved before the agent started

    agent.calls[0].opts.onUpdate([user("hello")], "Let me");
    expect(store.get("A")).toMatchObject({ streaming: "Let me" });
    agent.calls[0].opts.onUpdate([user("hello"), reply("Hi")], "");
    expect(store.get("A")!.messages).toEqual([user("hello"), reply("Hi")]);

    agent.calls[0].finish([reply("Hi there")]);
    await flush();
    expect(store.get("A")).toMatchObject({ phase: "idle", streaming: "", messages: [user("hello"), reply("Hi there")] });
    const last = lastOf(chatsSaved(saved, "A"))!;
    expect(last.messages).toEqual([user("hello"), reply("Hi there")]);
    expect(last.mode).toBe("ask");
  });

  it("ignores an empty message, and does nothing without a key or workspace", async () => {
    const { ctl, agent } = setup();
    ctl.create("A");
    ctl.send("A", "   ");
    const noKey = setup({ apiKey: () => null });
    noKey.ctl.create("A");
    noKey.ctl.send("A", "hi");
    await flush();
    expect(agent.runAgent).not.toHaveBeenCalled();
    expect(noKey.agent.runAgent).not.toHaveBeenCalled();
  });

  it("records an error when the agent fails, keeps the messages, and tells you", async () => {
    const { ctl, store, agent, notified } = setup();
    ctl.create("A");
    ctl.send("A", "hi");
    await flush();
    agent.calls[0].fail(new Error("401 bad key"));
    await flush();
    expect(store.get("A")).toMatchObject({ phase: "idle", error: "401 bad key", messages: [user("hi")] });
    expect(lastOf(notified)).toEqual(["A chat stopped with an error", "hi: 401 bad key"]);
  });

  it("saves progress every couple of seconds while the agent works, not on every word", async () => {
    vi.useFakeTimers();
    const { ctl, agent, saved } = setup();
    ctl.create("A");
    ctl.send("A", "hi");
    await vi.advanceTimersByTimeAsync(0);
    const before = saved.length;
    agent.calls[0].opts.onUpdate([user("hi")], "typing..."); // streaming: no save
    agent.calls[0].opts.onUpdate([user("hi"), reply("one")], "");
    agent.calls[0].opts.onUpdate([user("hi"), reply("one"), reply("two")], "");
    expect(saved.length).toBe(before);
    await vi.advanceTimersByTimeAsync(2100);
    expect(saved.length).toBe(before + 1);
    expect(lastOf(saved)!.chat.messages).toHaveLength(3);
  });
});

describe("two chats at once", () => {
  it("run side by side with their own messages, cost and activity", async () => {
    const { ctl, store, agent, audit } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "task A");
    ctl.send("B", "task B");
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(agent.peak()).toBe(2);
    expect(ctl.runningIds().sort()).toEqual(["A", "B"]);

    const [a, b] = agent.calls;
    a.opts.onUsage!({ model: "m", role: "main", who: "Main agent", promptTokens: 100, completionTokens: 10, cost: 0.5 });
    b.opts.onUsage!({ model: "m", role: "main", who: "Main agent", promptTokens: 7, completionTokens: 1, cost: 0.01 });
    a.opts.onUpdate([user("task A"), reply("A is working")], "");
    b.opts.onUpdate([user("task B")], "B streaming");
    a.opts.onEvent!({ category: "tool", summary: "read_file a" });

    expect(store.get("A")!.usage.cost).toBeCloseTo(0.5);
    expect(store.get("B")!.usage.cost).toBeCloseTo(0.01);
    expect(store.get("A")!.messages).toEqual([user("task A"), reply("A is working")]);
    expect(store.get("B")).toMatchObject({ messages: [user("task B")], streaming: "B streaming" });
    expect(store.get("A")!.events.some((e) => e.summary === "read_file a")).toBe(true);
    expect(store.get("B")!.events.some((e) => e.summary === "read_file a")).toBe(false);
    expect(audit.filter((e) => e.summary === "read_file a").map((e) => e.chatId)).toEqual(["A"]);

    a.finish();
    await flush();
    expect(store.get("A")!.phase).toBe("idle");
    expect(store.get("B")!.phase).toBe("running"); // one finishing doesn't touch the other
    b.finish();
    await flush();
    expect(ctl.anyRunning()).toBe(false);
  });

  it("never mixes chats when saving", async () => {
    const { ctl, agent, saved } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "only in A");
    ctl.send("B", "only in B");
    await flush();
    agent.calls[0].finish([reply("answer A")]);
    agent.calls[1].finish([reply("answer B")]);
    await flush();
    for (const { chat } of saved) {
      const text = JSON.stringify(chat.messages);
      if (chat.id === "A") expect(text).not.toContain("B");
      if (chat.id === "B") expect(text).not.toContain("only in A");
    }
    expect(lastOf(chatsSaved(saved, "A"))!.messages).toContainEqual(reply("answer A"));
    expect(lastOf(chatsSaved(saved, "B"))!.messages).toContainEqual(reply("answer B"));
  });

  it("an approval in one chat appears only there, and is answered from there", async () => {
    const { ctl, store, agent, notified } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "edit things");
    ctl.send("B", "just reading");
    await flush();
    const answerSeen = vi.fn();
    void agent.calls[0].opts.ask({ tool: "write_file", category: "write", args: {}, who: "Main agent", where: "app" }).then(answerSeen);
    await flush();
    expect(store.get("A")!.approvals).toHaveLength(1);
    expect(store.get("B")!.approvals).toHaveLength(0);
    expect(ctl.needingYou()).toEqual(["A"]);
    expect(store.getSummaries().get("A")).toMatchObject({ needsYou: true, phase: "running" });
    expect(store.getSummaries().get("B")).toMatchObject({ needsYou: false });
    expect(lastOf(notified)![0]).toBe("Needs your approval");

    ctl.answer("B", "once"); // answering B's (empty) queue does nothing to A
    expect(answerSeen).not.toHaveBeenCalled();
    ctl.answer("A", "always");
    await flush();
    expect(answerSeen).toHaveBeenCalledWith("always");
    expect(store.get("A")!.approvals).toHaveLength(0);
    expect(ctl.needingYou()).toEqual([]);
  });

  it("answers a chat's several waiting approvals one at a time, in order", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const results: string[] = [];
    const req = (tool: string) => ({ tool, category: "write" as const, args: {}, who: "w", where: "app" });
    void agent.calls[0].opts.ask(req("one")).then((a) => results.push(`one:${a}`));
    void agent.calls[0].opts.ask(req("two")).then((a) => results.push(`two:${a}`));
    await flush();
    expect(store.get("A")!.approvals.map((p) => p.req.tool)).toEqual(["one", "two"]);
    ctl.answer("A", "once");
    ctl.answer("A", "deny");
    await flush();
    expect(results).toEqual(["one:once", "two:deny"]);
  });

  it("Stop ends one chat's run and its commands, and leaves the other alone", async () => {
    const { ctl, store, agent, cancelled } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    const [a, b] = agent.calls;
    const approval = vi.fn();
    void a.opts.ask({ tool: "run_command", category: "command", args: {}, who: "w", where: "app" }).then(approval);
    await flush();

    ctl.stop("A");
    await flush();
    expect(a.opts.signal!.aborted).toBe(true);
    expect(b.opts.signal!.aborted).toBe(false);
    expect(cancelled).toEqual([a.opts.runKey]);
    expect(cancelled).not.toContain(b.opts.runKey);
    expect(approval).toHaveBeenCalledWith("deny");
    expect(store.get("A")).toMatchObject({ phase: "idle", stopped: true, approvals: [] });
    expect(store.get("B")!.phase).toBe("running");
  });

  it("Stop all stops every chat", async () => {
    const { ctl, store, agent, cancelled } = setup();
    ["A", "B", "C"].forEach((id) => {
      ctl.create(id);
      ctl.send(id, "go");
    });
    await flush();
    ctl.stopAll();
    await flush();
    expect(agent.calls.every((c) => c.opts.signal!.aborted)).toBe(true);
    expect(cancelled).toHaveLength(3);
    expect(ctl.anyRunning()).toBe(false);
    expect(store.all().every((s) => s.stopped)).toBe(true);
  });

  it("each run has its own key for cancelling commands", async () => {
    const { ctl, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    expect(agent.calls[0].opts.runKey).toBeTruthy();
    expect(agent.calls[0].opts.runKey).not.toBe(agent.calls[1].opts.runKey);
    expect(agent.calls[0].opts.checkpoint).toMatchObject({ chatId: "A" });
    expect(agent.calls[1].opts.checkpoint).toMatchObject({ chatId: "B" });
  });
});

describe("only so many chats work at once", () => {
  it("makes the rest wait their turn, in order, and never runs more than the limit", async () => {
    const { ctl, store, agent } = setup({}, { maxConcurrentRuns: 2 });
    ["A", "B", "C", "D", "E"].forEach((id) => {
      ctl.create(id);
      ctl.send(id, id);
    });
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(["A", "B"].map((id) => store.get(id)!.phase)).toEqual(["running", "running"]);
    expect(["C", "D", "E"].map((id) => store.get(id)!.phase)).toEqual(["waiting", "waiting", "waiting"]);
    expect(isBusy(store.get("C"))).toBe(true);

    agent.calls[0].finish();
    await flush();
    expect(agent.calls).toHaveLength(3);
    expect(agent.calls[2].opts.messages).toEqual([user("C")]); // first in line goes first
    expect(store.get("D")!.phase).toBe("waiting");

    agent.calls[1].finish();
    agent.calls[2].finish();
    await flush();
    agent.calls[3].finish();
    agent.calls[4].finish();
    await flush();
    expect(agent.calls).toHaveLength(5);
    expect(agent.peak()).toBe(2);
    expect(ctl.anyRunning()).toBe(false);
  });

  it("Stop on a chat that is waiting takes it out of line without ever starting the agent", async () => {
    const { ctl, store, agent } = setup({}, { maxConcurrentRuns: 1 });
    ctl.create("A");
    ctl.create("B");
    ctl.create("C");
    ["A", "B", "C"].forEach((id) => ctl.send(id, id));
    await flush();
    expect(store.get("B")!.phase).toBe("waiting");
    ctl.stop("B");
    await flush();
    expect(store.get("B")).toMatchObject({ phase: "idle", stopped: true, messages: [user("B")] });
    agent.calls[0].finish();
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1].opts.messages).toEqual([user("C")]); // B was skipped
  });

  it("frees the slot when a run fails or is stopped", async () => {
    const { ctl, agent } = setup({}, { maxConcurrentRuns: 1 });
    ctl.create("A");
    ctl.create("B");
    ctl.create("C");
    ["A", "B", "C"].forEach((id) => ctl.send(id, id));
    await flush();
    agent.calls[0].fail(new Error("boom"));
    await flush();
    expect(agent.calls).toHaveLength(2);
    ctl.stop("B");
    await flush();
    expect(agent.calls).toHaveLength(3);
  });
});

describe("news from chats you're not looking at", () => {
  it("marks a chat that finished while you were elsewhere, and clears the mark when you open it", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.activate("A");
    ctl.send("A", "go");
    await flush();
    ctl.activate("B"); // you go and read another chat
    agent.calls[0].finish();
    await flush();
    expect(store.get("A")!.attention).toBe("done");
    expect(store.getSummaries().get("A")!.attention).toBe("done");
    ctl.activate("A");
    expect(store.get("A")!.attention).toBeNull();
  });

  it("marks a failure, but not a chat you're looking at or one you stopped", async () => {
    const { ctl, store, agent } = setup();
    ["A", "B", "C"].forEach((id) => ctl.create(id));
    ctl.activate("A");
    ["A", "B", "C"].forEach((id) => ctl.send(id, "go"));
    await flush();
    agent.calls[0].finish(); // A: on screen
    agent.calls[1].fail(new Error("x")); // B: off screen, failed
    ctl.stop("C");
    await flush();
    expect(store.get("A")!.attention).toBeNull();
    expect(store.get("B")!.attention).toBe("failed");
    expect(store.get("C")!.attention).toBeNull();
  });

  it("tells you when a chat finishes", async () => {
    const { ctl, agent, notified } = setup();
    ctl.create("A");
    ctl.send("A", "fix the login");
    await flush();
    agent.calls[0].finish();
    await flush();
    expect(notified).toContainEqual(["A chat finished", "fix the login"]);
  });
});

describe("a mode for each chat", () => {
  it("is separate for each chat and takes effect during a run", async () => {
    const { ctl, store, agent } = setup({ defaultMode: () => "ask" as Mode });
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "go");
    await flush();
    const getMode = agent.calls[0].opts.getMode;
    expect(getMode()).toBe("ask");
    ctl.setMode("B", "bypass");
    expect(getMode()).toBe("ask");
    expect(store.get("B")!.mode).toBe("bypass");
    ctl.setMode("A", "plan", true);
    expect(getMode()).toBe("plan");
    expect(store.get("A")!.events.some((e) => e.summary === "Mode changed to Plan")).toBe(true);
  });

  it("starts from your default, is saved with the chat, and comes back when it is opened", async () => {
    const { ctl, agent, saved } = setup({ defaultMode: () => "acceptEdits" as Mode });
    ctl.create("A");
    expect(ctl.store.get("A")!.mode).toBe("acceptEdits");
    ctl.setMode("A", "plan");
    ctl.send("A", "go");
    await flush();
    agent.calls[0].finish();
    await flush();
    expect(lastOf(chatsSaved(saved, "A"))!.mode).toBe("plan");
    const { ctl: other } = setup({ defaultMode: () => "ask" as Mode });
    expect(other.ensure({ ...lastOf(chatsSaved(saved, "A")) }).mode).toBe("plan");
    expect(other.ensure({ ...lastOf(chatsSaved(saved, "A")), id: "X", mode: undefined }).mode).toBe("ask");
  });

  it("the plan-mode approval switches this chat to auto-accept and carries on", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.setMode("A", "plan");
    store.update("A", { messages: [user("plan it"), reply("here is the plan")] });
    ctl.approvePlan("A");
    await flush();
    expect(store.get("A")!.mode).toBe("acceptEdits");
    expect(lastOf(agent.calls[0].opts.messages)).toEqual(user("The plan is approved. Go ahead and carry it out."));
  });
});

describe("drafts and the queue", () => {
  it("keeps a draft for each chat", () => {
    const { ctl, store } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.setDraft("A", "half a thought");
    ctl.appendDraft("B", "spoken");
    ctl.appendDraft("B", "words");
    expect(store.get("A")!.draft).toBe("half a thought");
    expect(store.get("B")!.draft).toBe("spoken words");
  });

  it("queues what you send while the agent works and sends it when the run finishes", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "first");
    await flush();
    ctl.send("A", "second");
    ctl.send("A", "third");
    expect(store.get("A")!.queue.map((q) => q.text)).toEqual(["second", "third"]);
    agent.calls[0].finish([reply("one")]);
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1].opts.messages).toEqual([user("first"), reply("one"), user("second")]);
    expect(store.get("A")!.queue.map((q) => q.text)).toEqual(["third"]);
  });

  it("one chat's queue is not another's", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a1");
    await flush();
    ctl.send("A", "a2");
    expect(store.get("B")!.queue).toEqual([]);
    expect(agent.calls).toHaveLength(1);
  });

  it("'send now' joins the run at its next step", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "first");
    await flush();
    ctl.send("A", "also this");
    const id = store.get("A")!.queue[0].id;
    ctl.sendQueued("A", id);
    expect(store.get("A")!.queue[0].steering).toBe(true);
    expect(agent.calls[0].opts.takeSteering!()).toEqual(["also this"]);
    expect(store.get("A")!.queue).toEqual([]);
  });

  it("puts a 'send now' message the run never read back in line, and sends it afterwards", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "first");
    await flush();
    ctl.send("A", "late");
    ctl.sendQueued("A", store.get("A")!.queue[0].id);
    agent.calls[0].finish();
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(lastOf(agent.calls[1].opts.messages)).toEqual(user("late"));
  });

  it("can take a queued message back or remove it", async () => {
    const { ctl, store } = setup();
    ctl.create("A");
    store.update("A", { phase: "running" });
    ctl.send("A", "keep me");
    ctl.send("A", "drop me");
    const [keep, drop] = store.get("A")!.queue;
    expect(ctl.takeQueued("A", keep.id)).toBe("keep me");
    ctl.removeQueued("A", drop.id);
    expect(store.get("A")!.queue).toEqual([]);
    expect(ctl.takeQueued("A", "nope")).toBeNull();
  });

  it("does not send the queue after Stop or a failure, and Stop can clear or keep it", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    ctl.send("A", "queued a");
    ctl.send("B", "queued b");
    ctl.stop("A");
    agent.calls[1].fail(new Error("x"));
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(store.get("A")!.queue).toHaveLength(1);
    ctl.clearQueue("A");
    expect(store.get("A")!.queue).toEqual([]);
    store.update("B", { queue: [{ id: "q", text: "t", steering: true }] });
    ctl.keepQueue("B");
    expect(store.get("B")!.queue[0].steering).toBe(false);
  });
});

describe("the budget", () => {
  it("is per chat: one chat reaching its cap doesn't stop another", async () => {
    const { ctl, agent } = setup({}, { budgetUsd: 1 });
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    const [a, b] = agent.calls;
    expect(a.opts.overBudget!()).toBeNull();
    a.opts.onUsage!({ model: "m", role: "main", who: "w", promptTokens: 1, completionTokens: 1, cost: 1.5 });
    expect(a.opts.overBudget!()).toBe(1);
    expect(b.opts.overBudget!()).toBeNull();
  });

  it("extra budget for one chat applies to that chat only", async () => {
    const { ctl, agent, store } = setup({}, { budgetUsd: 1 });
    ctl.create("A");
    ctl.create("B");
    ctl.addBudget("A", 2);
    expect(store.get("A")!.meta.budgetExtra).toBe(2);
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    agent.calls[0].opts.onUsage!({ model: "m", role: "main", who: "w", promptTokens: 1, completionTokens: 1, cost: 1.5 });
    agent.calls[1].opts.onUsage!({ model: "m", role: "main", who: "w", promptTokens: 1, completionTokens: 1, cost: 1.5 });
    expect(agent.calls[0].opts.overBudget!()).toBeNull(); // cap is 3 for A
    expect(agent.calls[1].opts.overBudget!()).toBe(1);
  });

  it("warns once near the cap and once near the model's context limit", async () => {
    const { ctl, agent, store } = setup(
      { modelInfo: () => ({ id: "m", name: "m", contextLength: 1000, inputPerM: 0, outputPerM: 0 }) },
      { budgetUsd: 1 },
    );
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const use = (cost: number, tokens: number) => agent.calls[0].opts.onUsage!({ model: "m", role: "main", who: "w", promptTokens: tokens, completionTokens: 1, cost });
    use(0.85, 750);
    use(0.9, 760);
    use(0.95, 950);
    const warnings = store.get("A")!.events.filter((e) => e.level === "warn").map((e) => e.summary);
    expect(warnings).toEqual([
      "The conversation fills 75% of the model's context",
      "This chat has used 80% of its $1.00 budget",
      "The conversation fills 95% of the model's context",
    ]);
  });
});

describe("two chats in one project", () => {
  const project = { name: "app", writable: true };

  it("warns each when they overlap, and not when they don't", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.create("C");
    store.update("A", { projects: [project] });
    store.update("B", { projects: [project] });
    store.update("C", { projects: [{ name: "other", writable: true }] });
    ctl.send("A", "a");
    await flush();
    expect(store.get("A")!.notice).toBe("");
    ctl.send("B", "b");
    await flush();
    expect(store.get("B")!.notice).toMatch(/"a" is also working in app/);
    expect(store.get("B")!.events.some((e) => e.level === "warn" && e.summary.includes("also working in app"))).toBe(true);
    ctl.send("C", "c");
    await flush();
    expect(store.get("C")!.notice).toBe("");
    expect(agent.calls).toHaveLength(3);
  });

  it("read-only use of a project does not count as a clash", async () => {
    const { ctl, store } = setup();
    ctl.create("A");
    ctl.create("B");
    store.update("A", { projects: [project] });
    store.update("B", { projects: [{ name: "app", writable: false }] });
    ctl.send("A", "a");
    await flush();
    ctl.send("B", "b");
    await flush();
    expect(store.get("B")!.notice).toBe("");
  });

  it("makes a branch for a chat only when no other chat is working in the project", async () => {
    const gitCreateBranch = vi.fn(async () => {});
    const { ctl, store, agent } = setup({
      branchPerChat: () => true,
      gitCreateBranch,
      gitStatus: async () => ({ hasGit: true, isRepo: true, branch: "main", detached: false, changed: 0, untracked: 0, blocked: null }),
    });
    ctl.create("A");
    ctl.create("B");
    store.update("A", { projects: [project] });
    store.update("B", { projects: [project] });
    ctl.send("A", "first chat");
    await flush();
    ctl.send("B", "second chat");
    await flush();
    await agent.calls[1].opts.beforeWrite!("app"); // B writes while A is working in the same project
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(store.get("B")!.events.some((e) => e.summary.startsWith("Didn't make a branch for app"))).toBe(true);

    agent.calls[0].finish();
    agent.calls[1].finish();
    await flush();
    ctl.send("A", "again");
    await flush();
    await agent.calls[2].opts.beforeWrite!("app"); // now alone in the project
    expect(gitCreateBranch).toHaveBeenCalledOnce();
    expect(gitCreateBranch).toHaveBeenCalledWith("/ws", "app", expect.stringMatching(/^billybot\/.+-/));
    await agent.calls[2].opts.beforeWrite!("app"); // only once per chat and project
    expect(gitCreateBranch).toHaveBeenCalledOnce();
  });

  it("does nothing about branches when the setting is off", async () => {
    const gitCreateBranch = vi.fn(async () => {});
    const { ctl, agent } = setup({ branchPerChat: () => false, gitCreateBranch });
    ctl.create("A");
    ctl.send("A", "a");
    await flush();
    await agent.calls[0].opts.beforeWrite!("app");
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });
});

describe("opening, renaming and deleting chats", () => {
  const saved: Conversation = {
    id: "S", title: "Saved chat", updatedAt: 50, messages: [user("hi"), reply("hello")], projects: [{ name: "app", writable: true }],
    subagents: {}, usage: undefined, checkpoints: [{ run: "r1", turn: 0 }],
  };

  it("opening a chat that is working shows the live session, not what was last saved", async () => {
    const { ctl, store, agent } = setup();
    ctl.ensure(saved);
    ctl.send("S", "more");
    await flush();
    agent.calls[0].opts.onUpdate([...saved.messages, user("more"), reply("live progress")], "");
    const again = ctl.ensure(saved); // as when you click it in the sidebar
    expect(again).toBe(store.get("S"));
    expect(again.messages).toHaveLength(4);
    expect(again.phase).toBe("running");
  });

  it("repairs a chat that was cut off by closing the app", () => {
    const { ctl } = setup();
    const cut: Conversation = {
      ...saved,
      messages: [user("go"), { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }] }],
      subagents: { c1: { project: "app", task: "t", status: "running", messages: [] } },
    };
    const s = ctl.ensure(cut);
    expect(s.closedMidRun).toBe(true);
    expect(lastOf(s.messages)).toEqual({ role: "tool", tool_call_id: "c1", content: INTERRUPTED_RESULT });
    expect(s.subagents.c1.status).toBe("stopped");
  });

  it("renames and pins a chat that is working without disturbing it, and later saves keep the new name", async () => {
    const { ctl, store, agent, saved: out } = setup();
    ctl.ensure(saved);
    ctl.send("S", "more");
    await flush();
    agent.calls[0].opts.onUpdate([...saved.messages, user("more"), reply("part")], "");
    ctl.updateMeta("S", { title: "  My name  ", pinned: true });
    await flush();
    expect(store.get("S")).toMatchObject({ phase: "running", meta: { title: "My name", titleEdited: true, pinned: true } });
    expect(store.get("S")!.messages).toHaveLength(4);
    expect(titleOf(store.get("S")!)).toBe("My name");
    agent.calls[0].finish([reply("end")]);
    await flush();
    const last = lastOf(chatsSaved(out, "S"))!;
    expect(last).toMatchObject({ title: "My name", titleEdited: true, pinned: true });
    expect(lastOf(last.messages)).toEqual(reply("end"));
  });

  it("renaming an idle chat does not move it up the list", async () => {
    const { ctl, saved: out } = setup();
    ctl.ensure(saved);
    ctl.updateMeta("S", { title: "New name" });
    await flush();
    expect(lastOf(chatsSaved(out, "S"))).toMatchObject({ title: "New name", updatedAt: 50 });
  });

  it("refuses to forget a chat that is working, and lets go of an idle one", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "go");
    await flush();
    expect(ctl.remove("A")).toBe(false);
    expect(store.has("A")).toBe(true);
    expect(ctl.remove("B")).toBe(true);
    expect(store.has("B")).toBe(false);
    agent.calls[0].finish();
    await flush();
    expect(ctl.remove("A")).toBe(true);
  });

  it("switching workspace stops everything and forgets every session", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    ctl.reset();
    await flush();
    expect(agent.calls.every((c) => c.opts.signal!.aborted)).toBe(true);
    expect(store.all()).toEqual([]);
    expect(ctl.displayed).toBeNull();
  });

  it("lets go of old idle sessions but never a working one, the one on screen, or one with a draft", async () => {
    const { ctl, store, agent } = setup();
    for (let i = 0; i < 14; i++) ctl.create(`c${i}`);
    ctl.send("c0", "working");
    await flush();
    ctl.setDraft("c1", "unsent");
    ctl.activate("c2");
    ctl.activate("c13"); // trims
    const kept = store.all().map((s) => s.id);
    expect(kept).toEqual(expect.arrayContaining(["c0", "c1", "c13"]));
    expect(kept.length).toBeLessThanOrEqual(8 + 3);
    expect(agent.calls[0].stopped).toBe(false);
  });
});

describe("forking and editing", () => {
  const convo: Conversation = {
    id: "A", title: "Original", updatedAt: 1, messages: [user("one"), reply("r1"), user("two"), reply("r2")],
    projects: [{ name: "app", writable: true }], subagents: {}, usage: { cost: 3, promptTokens: 1, completionTokens: 1, requests: 1, estimated: 0, unpriced: 0, turns: {} },
  };

  it("forking makes a separate chat with no cost that doesn't disturb a chat that's busy elsewhere", async () => {
    const { ctl, store, saved, agent } = setup();
    ctl.ensure(convo);
    ctl.create("B");
    ctl.send("B", "busy");
    await flush();
    const id = await ctl.fork("A", 1);
    expect(id).toBeTruthy();
    const fork = store.get(id!)!;
    expect(fork.messages).toEqual([user("one"), reply("r1")]);
    expect(fork.usage.cost).toBe(0);
    expect(fork.meta).toMatchObject({ title: "one (fork)", forkedFrom: { chatId: "A", messageIndex: 1 } });
    expect(store.get("A")!.messages).toHaveLength(4);
    expect(store.get("B")!.phase).toBe("running");
    expect(chatsSaved(saved, id!)).toHaveLength(1);
    expect(agent.calls).toHaveLength(1);
  });

  it("edit in a new chat starts that chat working and leaves the original alone", async () => {
    const { ctl, store, agent } = setup();
    ctl.ensure(convo);
    const id = await ctl.editInFork("A", 2, "two, but different");
    await flush();
    expect(id).not.toBe("A");
    expect(agent.calls[0].opts.messages).toEqual([user("one"), reply("r1"), user("two, but different")]);
    expect(store.get(id!)!.phase).toBe("running");
    expect(store.get("A")).toMatchObject({ phase: "idle", messages: convo.messages });
  });

  it("edit in place replaces the message and what came after it", async () => {
    const { ctl, agent } = setup();
    ctl.ensure(convo);
    await ctl.editInPlace("A", 2, "better two", false);
    await flush();
    expect(agent.calls[0].opts.messages).toEqual([user("one"), reply("r1"), user("better two")]);
  });

  it("regenerate keeps your message and asks again, and can undo the reply's file changes first", async () => {
    const revertRuns = vi.fn(async () => ({ restored: 2, deleted: 0, skipped: [] }));
    const { ctl, store, agent } = setup({ revertRuns });
    ctl.ensure({ ...convo, checkpoints: [{ run: "r-old", turn: 0 }, { run: "r-new", turn: 2 }] });
    await ctl.regenerate("A", true);
    await flush();
    expect(revertRuns).toHaveBeenCalledWith("A", ["r-new"], false);
    expect(agent.calls[0].opts.messages).toEqual([user("one"), reply("r1"), user("two")]);
    expect(store.get("A")!.notice).toBe("Undone: restored 2 files.");
  });

  it("regenerate without undo leaves the files alone", async () => {
    const revertRuns = vi.fn(async () => ({ restored: 0, deleted: 0, skipped: [] }));
    const { ctl } = setup({ revertRuns });
    ctl.ensure(convo);
    await ctl.regenerate("A", false);
    await flush();
    expect(revertRuns).not.toHaveBeenCalled();
  });

  it("edits and forks are refused while the chat is working", async () => {
    const { ctl, agent } = setup();
    ctl.ensure(convo);
    ctl.send("A", "more");
    await flush();
    expect(await ctl.fork("A", 1)).toBeNull();
    expect(await ctl.editInFork("A", 2, "x")).toBeNull();
    await ctl.editInPlace("A", 2, "x", false);
    await ctl.regenerate("A", false);
    expect(agent.calls).toHaveLength(1);
  });
});

describe("undo and continuing", () => {
  it("counts each turn's changed files and forgets runs that changed nothing", async () => {
    const { ctl, store } = setup({
      checkpointStatus: async () => [{ runId: "r1", files: 2 }, { runId: "r2", files: 0 }],
    });
    ctl.ensure({ id: "A", title: "t", updatedAt: 1, messages: [user("x")], projects: [], subagents: {}, checkpoints: [{ run: "r1", turn: 0 }, { run: "r2", turn: 0 }] });
    await ctl.refreshChanged("A");
    expect(store.get("A")!.changed).toEqual({ "0": 2 });
    expect(store.get("A")!.runs).toEqual([{ run: "r1", turn: 0 }]);
  });

  it("reports what an undo did, and tells the app to look at git again", async () => {
    const gitChanged = vi.fn();
    const { ctl, store } = setup({ revertRuns: async () => ({ restored: 1, deleted: 1, skipped: ["app/x: changed"] }), gitChanged });
    ctl.ensure({ id: "A", title: "t", updatedAt: 1, messages: [user("x")], projects: [{ name: "app", writable: true }], subagents: {} });
    await ctl.undoRuns("A", ["r1"], false);
    expect(store.get("A")!.notice).toBe("Undone: restored 1 file and deleted 1 new file. Left alone: app/x: changed.");
    expect(gitChanged).toHaveBeenCalledWith(["app"]);
  });

  it("continues a stopped chat, or asks again when the last message never got an answer", async () => {
    const { ctl, agent } = setup();
    ctl.ensure({ id: "A", title: "t", updatedAt: 1, messages: [user("go"), reply("part")], projects: [], subagents: {}, stopped: true });
    ctl.ensure({ id: "B", title: "t", updatedAt: 1, messages: [user("unanswered")], projects: [], subagents: {} });
    ctl.continueRun("A");
    ctl.continueRun("B");
    await flush();
    expect(lastOf(agent.calls[0].opts.messages)).toEqual(user("Continue."));
    expect(agent.calls[1].opts.messages).toEqual([user("unanswered")]);
  });

  it("raising the budget and continuing uses the new cap straight away", async () => {
    const { ctl, store, agent } = setup({}, { budgetUsd: 1 });
    ctl.ensure({ id: "A", title: "t", updatedAt: 1, messages: [user("go"), reply("Stopped: this chat reached its budget of $1.00.")], projects: [], subagents: {},
      usage: { cost: 1.2, promptTokens: 1, completionTokens: 1, requests: 1, estimated: 0, unpriced: 0, turns: {} } });
    ctl.addBudgetAndContinue("A", 1);
    await flush();
    expect(store.get("A")!.meta.budgetExtra).toBe(1);
    expect(agent.calls[0].opts.overBudget!()).toBeNull(); // 1.2 < 2
  });
});

describe("helpers", () => {
  it("spots replies that changed things", () => {
    const call = (name: string): Msg => ({ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name, arguments: "{}" } }] });
    expect(actedIn([call("write_file")])).toBe(true);
    expect(actedIn([call("run_command")])).toBe(true);
    expect(actedIn([call("read_file"), reply("x")])).toBe(false);
  });

  it("the sidebar summaries only change when something that matters does", () => {
    const store = new SessionStore();
    const { ctl } = setup({}, {});
    void ctl;
    const c = createController({ workspace: () => "/ws", apiKey: () => "k", model: () => "m", limits: () => DEFAULT_LIMITS }, store);
    c.create("A");
    const first = store.getSummaries();
    c.setDraft("A", "typing"); // not a summary field
    expect(store.getSummaries()).toBe(first);
    store.update("A", { phase: "running" });
    expect(store.getSummaries()).not.toBe(first);
    expect(store.getSummaries().get("A")!.phase).toBe("running");
  });
});

describe("questions from the agent", () => {
  it("waits for your answer in that chat only, marks the chat as needing you, and passes the answer back", async () => {
    const { ctl, store, agent, notified } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "build it");
    ctl.send("B", "other");
    await flush();
    const got = vi.fn();
    void agent.calls[0].opts.askUser!({ question: "Postgres or SQLite?", options: ["Postgres", "SQLite"] }).then(got);
    await flush();
    expect(store.get("A")!.questions.map((q) => q.question)).toEqual(["Postgres or SQLite?"]);
    expect(store.get("B")!.questions).toEqual([]);
    expect(ctl.needingYou()).toEqual(["A"]);
    expect(store.getSummaries().get("A")!.needsYou).toBe(true);
    expect(lastOf(notified)).toEqual(["Has a question for you", "build it: Postgres or SQLite?"]);

    ctl.answerQuestion("B", "ignored"); // nothing to answer in B
    expect(got).not.toHaveBeenCalled();
    ctl.answerQuestion("A", "  SQLite  ");
    await flush();
    expect(got).toHaveBeenCalledWith("SQLite");
    expect(store.get("A")!.questions).toEqual([]);
    expect(ctl.needingYou()).toEqual([]);
  });

  it("answers several questions in the order they were asked", async () => {
    const { ctl, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const order: string[] = [];
    void agent.calls[0].opts.askUser!({ question: "one", options: [] }).then((a) => order.push(`one=${a}`));
    void agent.calls[0].opts.askUser!({ question: "two", options: [] }).then((a) => order.push(`two=${a}`));
    ctl.answerQuestion("A", "x");
    ctl.answerQuestion("A", "y");
    await flush();
    expect(order).toEqual(["one=x", "two=y"]);
  });

  it("Stop gives the agent a 'no answer' and clears the question", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const got = vi.fn();
    void agent.calls[0].opts.askUser!({ question: "sure?", options: [] }).then(got);
    ctl.stop("A");
    await flush();
    expect(got).toHaveBeenCalledWith(null);
    expect(store.get("A")!.questions).toEqual([]);
  });

  it("needs-you counts a question the same as an approval", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "a");
    ctl.send("B", "b");
    await flush();
    void agent.calls[0].opts.askUser!({ question: "q", options: [] });
    void agent.calls[1].opts.ask({ tool: "write_file", category: "write", args: {}, who: "w", where: "app" });
    await flush();
    expect(ctl.needingYou().sort()).toEqual(["A", "B"]);
    expect([...store.getSummaries()].filter(([, v]) => v.needsYou)).toHaveLength(2);
  });
});

describe("the to-do list", () => {
  const items = [{ content: "Read", status: "completed" as const }, { content: "Fix", status: "in_progress" as const }];

  it("belongs to the chat, shows live, and is saved and restored", async () => {
    const { ctl, store, agent, saved } = setup();
    ctl.create("A");
    ctl.create("B");
    ctl.send("A", "go");
    await flush();
    agent.calls[0].opts.onTodos!(items);
    expect(store.get("A")!.todos).toEqual(items);
    expect(store.get("B")!.todos).toEqual([]);
    agent.calls[0].finish();
    await flush();
    expect(lastOf(chatsSaved(saved, "A")).todos).toEqual(items);
    const { ctl: other } = setup();
    expect(other.ensure(lastOf(chatsSaved(saved, "A"))).todos).toEqual(items);
  });

  it("stays across messages, and can be cleared when the agent is not working", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    agent.calls[0].opts.onTodos!(items);
    ctl.clearTodos("A"); // working: refused
    expect(store.get("A")!.todos).toHaveLength(2);
    agent.calls[0].finish();
    await flush();
    ctl.send("A", "next");
    await flush();
    expect(store.get("A")!.todos).toHaveLength(2);
    agent.calls[1].finish();
    await flush();
    ctl.clearTodos("A");
    expect(store.get("A")!.todos).toEqual([]);
  });
});

describe("subagents inside a chat", () => {
  const sub = (over: object = {}) => ({ project: "app", task: "t", status: "running" as const, messages: [], ...over });

  it("stopping one declines only its approvals and calls its own stop", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    agent.calls[0].opts.registerSubagent!("d1", stop1);
    agent.calls[0].opts.registerSubagent!("d2", stop2);
    const answers: string[] = [];
    const req = (owner: string | undefined) => ({ tool: "write_file", category: "write" as const, args: {}, who: "w", where: "app", owner });
    void agent.calls[0].opts.ask(req("d1")).then((a) => answers.push(`d1:${a}`));
    void agent.calls[0].opts.ask(req("d2")).then((a) => answers.push(`d2:${a}`));
    void agent.calls[0].opts.ask(req(undefined)).then((a) => answers.push(`main:${a}`));
    await flush();
    ctl.stopSubagent("A", "d1");
    await flush();
    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).not.toHaveBeenCalled();
    expect(answers).toEqual(["d1:deny"]);
    expect(store.get("A")!.approvals.map((p) => p.req.owner)).toEqual(["d2", undefined]);
    expect(store.get("A")!.phase).toBe("running");
  });

  it("forgets a subagent's stop when it ends or the run does", async () => {
    const { ctl, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const stop = vi.fn();
    agent.calls[0].opts.registerSubagent!("d1", stop);
    agent.calls[0].opts.registerSubagent!("d1", null);
    ctl.stopSubagent("A", "d1");
    expect(stop).not.toHaveBeenCalled();
    agent.calls[0].opts.registerSubagent!("d2", stop);
    agent.calls[0].finish();
    await flush();
    ctl.stopSubagent("A", "d2");
    expect(stop).not.toHaveBeenCalled();
  });

  it("adds a subagent's spending to its own record as well as the chat's", async () => {
    const { ctl, store, agent } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    agent.calls[0].opts.onSubagent!("d1", sub());
    const use = (callId: string | undefined, cost: number) =>
      agent.calls[0].opts.onUsage!({ model: "m", role: callId ? "sub" : "main", who: "w", promptTokens: 1, completionTokens: 1, cost, callId });
    use("d1", 0.25);
    use("d1", 0.5);
    use(undefined, 1);
    expect(store.get("A")!.subagents.d1.cost).toBeCloseTo(0.75);
    expect(store.get("A")!.usage.cost).toBeCloseTo(1.75);
  });

  it("keeps a subagent's transcript when saving, but cuts long tool results", async () => {
    const { ctl, agent, saved, store } = setup();
    ctl.create("A");
    ctl.send("A", "go");
    await flush();
    const big = "x".repeat(5000);
    agent.calls[0].opts.onSubagent!("d1", sub({
      status: "done", streaming: "typing",
      messages: [user("task"), { role: "tool", tool_call_id: "c", content: big }, { role: "tool", tool_call_id: "c2", content: "short" }],
    }));
    agent.calls[0].finish();
    await flush();
    const savedSub = lastOf(chatsSaved(saved, "A")).subagents.d1;
    const results = savedSub.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results[0].length).toBeLessThan(2100);
    expect(results[0]).toContain("3,000 more characters not kept");
    expect(results[1]).toBe("short");
    expect(savedSub.streaming).toBeUndefined();
    expect(String(store.get("A")!.subagents.d1.messages[1].content)).toBe(big); // what's on screen is whole
  });
});

describe("making room in a long chat", () => {
  const bigResult = (n: number) => "x".repeat(n * 4);
  /** A working session: a request, then rounds of reading files. */
  const longChat = (rounds = 10, tokens = 1500): Msg[] => {
    const out: Msg[] = [user("big job")];
    for (let i = 0; i < rounds; i++) {
      out.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: '{"path":"app/a"}' } }] });
      out.push({ role: "tool", tool_call_id: `c${i}`, content: bigResult(tokens) });
    }
    out.push(reply("done for now"));
    return out;
  };
  const stored = (id: string, messages: Msg[], over: Partial<Conversation> = {}): Conversation => ({
    id, title: "t", updatedAt: 1, messages, projects: [], subagents: {}, ...over,
  });
  const summary = (text = "Summary of the work.") =>
    vi.fn(async (_o: { previous: string; slice: Msg[]; todos?: unknown[] }) => ({ text, promptTokens: 4000, completionTokens: 200, cost: 0.02 }));
  const win = { modelInfo: () => ({ id: "m", name: "m", contextLength: 40_000, inputPerM: 3, outputPerM: 15 }) };

  it("summarizes the older messages, keeps every message, and counts what the summary cost", async () => {
    const summarizeFn = summary();
    const { ctl, store, agent, audit } = setup({ summarize: summarizeFn, ...win });
    const messages = longChat();
    ctl.ensure(stored("A", messages, { todos: [{ content: "Finish", status: "in_progress" }] }));
    ctl.send("A", "carry on");
    await flush();
    const compact = agent.calls[0].opts.compact!;
    const next = await compact(store.get("A")!.messages, null);
    expect(next).toMatchObject({ summary: "Summary of the work." });
    expect(next!.upTo).toBeGreaterThan(4);
    expect(store.get("A")!.compaction).toEqual(next);
    expect(store.get("A")!.messages.length).toBe(messages.length + 1); // nothing was removed
    expect(store.get("A")!.usage.cost).toBeCloseTo(0.02);
    expect(next!.tokensAfter!).toBeLessThan(next!.tokensBefore!);

    const args = summarizeFn.mock.calls[0][0] as { previous: string; slice: Msg[]; todos: unknown[] };
    expect(args.previous).toBe("");
    expect(args.slice).toEqual(messages.slice(0, next!.upTo));
    expect(args.todos).toHaveLength(1);
    expect(store.get("A")!.notice).toMatch(/Summarized \d+ earlier messages: the model now sees about [\d,]+ tokens instead of [\d,]+\. Every message is still here\./);
    expect(audit.some((e) => e.summary.startsWith("Summarized"))).toBe(true);
  });

  it("gives the agent its window, its trigger and the compaction it already has", async () => {
    const existing = { upTo: 3, summary: "Old summary.", at: 1 };
    const { ctl, agent } = setup({ ...win }, { compactAtPercent: 70 });
    ctl.ensure(stored("A", longChat(4), { compaction: existing }));
    ctl.send("A", "go");
    await flush();
    expect(agent.calls[0].opts).toMatchObject({ contextWindow: 40_000, compactAt: 0.7, compaction: existing });
    expect(agent.calls[0].opts.compact).toBeTypeOf("function");
  });

  it("builds on an earlier summary, folding in only the messages since", async () => {
    const summarizeFn = summary("Newer summary.");
    const { ctl, store, agent } = setup({ summarize: summarizeFn, ...win });
    const messages = longChat(16);
    ctl.ensure(stored("A", messages, { compaction: { upTo: 5, summary: "First summary.", at: 1 } }));
    ctl.send("A", "go");
    await flush();
    const next = await agent.calls[0].opts.compact!(store.get("A")!.messages, store.get("A")!.compaction);
    const args = summarizeFn.mock.calls[0][0] as { previous: string; slice: Msg[] };
    expect(args.previous).toBe("First summary.");
    expect(args.slice[0]).toEqual(messages[5]);
    expect(next!.upTo).toBeGreaterThan(5);
    expect(store.get("A")!.compaction!.summary).toBe("Newer summary.");
  });

  it("does nothing, and doesn't call the model, when the chat is short", async () => {
    const summarizeFn = summary();
    const { ctl, store, agent } = setup({ summarize: summarizeFn, ...win });
    ctl.ensure(stored("A", [user("hi"), reply("hello")]));
    ctl.send("A", "more");
    await flush();
    expect(await agent.calls[0].opts.compact!(store.get("A")!.messages, null)).toBeNull();
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it("hides old tool results when the summary can't be made, and never touches your messages", async () => {
    const { ctl, store, agent } = setup({ summarize: vi.fn(async () => { throw new Error("402 out of credits"); }), ...win });
    const messages = longChat(30, 1500);
    ctl.ensure(stored("A", messages));
    ctl.send("A", "go");
    await flush();
    const next = await agent.calls[0].opts.compact!(store.get("A")!.messages, null);
    expect(next).toMatchObject({ summary: "" });
    expect(next!.dropResultsBefore).toBeGreaterThan(0);
    expect(store.get("A")!.notice).toMatch(/Couldn't summarize \(402 out of credits\)\. Old tool results were hidden from the model instead/);
    expect(store.get("A")!.events.some((e) => e.level === "warn" && e.summary.includes("402 out of credits"))).toBe(true);
    expect(store.get("A")!.messages.filter((m) => m.role === "user")).toEqual([user("big job"), user("go")]);
    expect(store.get("A")!.usage.cost).toBe(0); // the failed call cost nothing
  });

  it("stopping during a summary ends it quietly", async () => {
    let seen: AbortSignal | undefined;
    const slow = vi.fn((o: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      seen = o.signal;
      o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { ctl, store, agent } = setup({ summarize: slow as never, ...win });
    ctl.ensure(stored("A", longChat()));
    ctl.send("A", "go");
    await flush();
    const pending = agent.calls[0].opts.compact!(store.get("A")!.messages, null);
    await flush();
    ctl.stop("A");
    expect(await pending).toBeNull();
    expect(seen!.aborted).toBe(true);
    expect(store.get("A")!.compaction).toBeNull();
  });

  it("can be switched off", async () => {
    const { ctl, agent } = setup({ autoCompact: () => false, ...win });
    ctl.ensure(stored("A", longChat(3)));
    ctl.send("A", "go");
    await flush();
    expect(agent.calls[0].opts.compact).toBeUndefined();
  });

  it("is saved with the chat and comes back when it is opened", async () => {
    const { ctl, store, agent, saved } = setup({ summarize: summary(), ...win });
    ctl.ensure(stored("A", longChat()));
    ctl.send("A", "go");
    await flush();
    await agent.calls[0].opts.compact!(store.get("A")!.messages, null);
    agent.calls[0].finish();
    await flush();
    const last = lastOf(chatsSaved(saved, "A"));
    expect(last.compaction).toMatchObject({ summary: "Summary of the work." });
    const { ctl: other } = setup();
    expect(other.ensure(last).compaction).toEqual(last.compaction);
  });
});

describe("summarizing on request", () => {
  const messages = (): Msg[] => {
    const out: Msg[] = [user("job")];
    for (let i = 0; i < 12; i++) {
      out.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      out.push({ role: "tool", tool_call_id: `c${i}`, content: "y".repeat(6000) });
    }
    return out;
  };
  const chat = (over = {}): Conversation => ({ id: "A", title: "t", updatedAt: 1, messages: messages(), projects: [], subagents: {}, ...over });
  const win = { modelInfo: () => ({ id: "m", name: "m", contextLength: 30_000, inputPerM: 0, outputPerM: 0 }) };

  it("summarizes without sending anything to the agent, showing that it's working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const summarize = vi.fn(async () => { await gate; return { text: "S", promptTokens: 1, completionTokens: 1 }; });
    const { ctl, store, agent } = setup({ summarize, ...win });
    ctl.ensure(chat());
    const done = ctl.compactNow("A");
    await flush();
    expect(store.get("A")).toMatchObject({ phase: "running", streaming: "Summarizing earlier messages…" });
    release();
    await done;
    expect(store.get("A")).toMatchObject({ phase: "idle", streaming: "" });
    expect(store.get("A")!.compaction).toMatchObject({ summary: "S" });
    expect(agent.runAgent).not.toHaveBeenCalled();
  });

  it("Stop ends it", async () => {
    const slow = vi.fn((o: { signal?: AbortSignal }) => new Promise<never>((_, reject) => o.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const { ctl, store } = setup({ summarize: slow as never, ...win });
    ctl.ensure(chat());
    const done = ctl.compactNow("A");
    await flush();
    ctl.stop("A");
    await done;
    expect(store.get("A")).toMatchObject({ phase: "idle", compaction: null, stopped: false });
  });

  it("says so when there's nothing worth summarizing", async () => {
    const summarize = vi.fn();
    const { ctl, store } = setup({ summarize, ...win });
    ctl.ensure(chat({ messages: [user("hi"), reply("hello")] }));
    await ctl.compactNow("A");
    expect(store.get("A")!.notice).toMatch(/nothing worth summarizing/);
    expect(summarize).not.toHaveBeenCalled();
    ctl.create("B");
    await ctl.compactNow("B");
    expect(store.get("B")!.notice).toMatch(/nothing to summarize yet/);
  });

  it("is what typing /compact does, and it is not sent to the agent", async () => {
    const summarize = vi.fn(async () => ({ text: "S", promptTokens: 1, completionTokens: 1 }));
    const { ctl, store, agent } = setup({ summarize, ...win });
    ctl.ensure(chat());
    ctl.setDraft("A", "/compact");
    ctl.send("A", "  /compact ");
    await flush();
    expect(summarize).toHaveBeenCalledOnce();
    expect(agent.runAgent).not.toHaveBeenCalled();
    expect(store.get("A")!.draft).toBe("");
    expect(store.get("A")!.messages).toHaveLength(messages().length);
  });

  it("while the agent is working, /compact asks you to wait instead of queueing it", async () => {
    const { ctl, store, agent } = setup({ ...win });
    ctl.ensure(chat({ messages: [user("a"), reply("b")] }));
    ctl.send("A", "go");
    await flush();
    ctl.send("A", "/compact");
    expect(store.get("A")!.queue).toEqual([]);
    expect(store.get("A")!.notice).toMatch(/Wait for the agent to finish/);
    expect(agent.calls).toHaveLength(1);
  });

  it("does nothing while the agent is working", async () => {
    const summarize = vi.fn();
    const { ctl } = setup({ summarize, ...win });
    ctl.ensure(chat());
    ctl.send("A", "go");
    await flush();
    await ctl.compactNow("A");
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("a compaction when the chat is cut back", () => {
  const msgs = (n: number): Msg[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : reply(`r${i}`)));
  const chat = (compaction: object): Conversation => ({ id: "A", title: "t", updatedAt: 1, messages: msgs(10), projects: [], subagents: {}, compaction: { at: 1, ...compaction } as never });

  it("a fork keeps it only if the summary is wholly inside what's copied", async () => {
    const { ctl, store } = setup();
    ctl.ensure(chat({ upTo: 4, summary: "S" }));
    const inside = (await ctl.fork("A", 7))!;
    expect(store.get(inside)!.compaction).toMatchObject({ upTo: 4, summary: "S" });
    const outside = (await ctl.fork("A", 2))!;
    expect(store.get(outside)!.compaction).toBeNull();
  });

  it("regenerating and editing in place do the same", async () => {
    const { ctl, store } = setup();
    ctl.ensure(chat({ upTo: 6, summary: "S" }));
    await ctl.editInPlace("A", 2, "different", false); // keeps messages 0 and 1: the summary covers more than that
    await flush();
    expect(store.get("A")!.compaction).toBeNull();
    const { ctl: other, store: s2 } = setup();
    other.ensure(chat({ upTo: 2, summary: "S" }));
    await other.regenerate("A", false); // keeps up to your last message (index 8)
    await flush();
    expect(s2.get("A")!.compaction).toMatchObject({ upTo: 2 });
  });
});
