import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEvent } from "./activity";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let failNext = false;
let stored: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "audit_append") {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      stored.push(...(args.lines as string[]));
      return;
    }
    if (cmd === "audit_read") return stored.filter((l) => l.includes(`"chatId":"${args.chatId}"`)).slice(-(args.limit as number));
    throw new Error(`unexpected ${cmd}`);
  }),
}));

import { flushActivity, loadChatActivity, saveActivity } from "./auditLog";

const ev = (summary: string, extra: object = {}, chatId = "c1") => makeEvent({ category: "tool", summary, ...extra }, chatId);

beforeEach(async () => {
  vi.useFakeTimers();
  calls.length = 0;
  stored = [];
  await flushActivity();
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("the audit writer", () => {
  it("batches events and writes them after a moment", async () => {
    saveActivity(ev("one"));
    saveActivity(ev("two"));
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toHaveLength(1);
    expect((calls[0].args.lines as string[]).map((l) => JSON.parse(l).summary)).toEqual(["one", "two"]);
  });

  it("doesn't save events that are still running", async () => {
    saveActivity(ev("running", { pending: true }));
    await flushActivity();
    expect(calls).toHaveLength(0);
  });

  it("flushes on demand and does nothing when there is nothing to write", async () => {
    await flushActivity();
    expect(calls).toHaveLength(0);
    saveActivity(ev("x"));
    await flushActivity();
    expect(calls).toHaveLength(1);
  });

  it("keeps events that failed to save and sends them with the next batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failNext = true;
    saveActivity(ev("first"));
    await flushActivity();
    saveActivity(ev("second"));
    await flushActivity();
    expect(stored.map((l) => JSON.parse(l).summary)).toEqual(["first", "second"]);
  });

  it("reads one chat's events back, including ones not yet written", async () => {
    saveActivity(ev("mine", {}, "c1"));
    saveActivity(ev("theirs", {}, "c2"));
    const loaded = await loadChatActivity("c1");
    expect(loaded.map((e) => e.summary)).toEqual(["mine"]);
  });
});
