import { describe, expect, it } from "vitest";
import { groupCalls, mapLimit } from "./parallel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("returns results in the order of the items, however long each one takes", async () => {
    const out = await mapLimit([30, 5, 15, 1], 4, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:15", "3:1"]);
  });

  it("never has more than the limit in flight, and does use the whole limit", async () => {
    let live = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 8, async () => {
      live++;
      peak = Math.max(peak, live);
      await sleep(5);
      live--;
    });
    expect(peak).toBe(8);
  });

  it("copes with no items, one item and a silly limit", async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
    expect(await mapLimit([5], 8, async (n) => n * 2)).toEqual([10]);
    expect(await mapLimit([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
  });

  it("runs the rest even if one fails, then reports the failure", async () => {
    const done: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error("two failed");
        await sleep(2);
        done.push(n);
      }),
    ).rejects.toThrow("two failed");
    expect(done.sort()).toEqual([1, 3, 4]);
  });
});

describe("groupCalls", () => {
  const read = (n: string) => ({ n, p: true });
  const write = (n: string) => ({ n, p: false });
  const names = (groups: ReturnType<typeof groupCalls<{ n: string; p: boolean }>>) => groups.map((g) => `${g.parallel ? "‖" : "→"}${g.calls.map((c) => c.n).join(",")}`);

  it("joins neighbouring reads and keeps anything else alone, in place", () => {
    const groups = groupCalls([read("a"), read("b"), write("w"), read("c"), read("d"), read("e"), write("x"), write("y")], (c) => c.p);
    expect(names(groups)).toEqual(["‖a,b", "→w", "‖c,d,e", "→x", "→y"]);
  });

  it("makes a write a barrier between two reads", () => {
    expect(names(groupCalls([read("a"), write("w"), read("b")], (c) => c.p))).toEqual(["‖a", "→w", "‖b"]);
  });

  it("handles empty and all-parallel input", () => {
    expect(groupCalls([], () => true)).toEqual([]);
    expect(names(groupCalls([read("a"), read("b"), read("c")], (c) => c.p))).toEqual(["‖a,b,c"]);
  });
});
