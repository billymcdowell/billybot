import { describe, expect, it } from "vitest";
import { MAX_RESULT_CHARS, processResult, truncateStage, type ResultInfo, type ResultStage } from "./pipeline";

const info: ResultInfo = { tool: "read_file", who: "Main agent", status: "ok" };

describe("truncateStage", () => {
  it("leaves a short result alone", async () => {
    expect(await processResult("hello", info)).toBe("hello");
    const exact = "x".repeat(MAX_RESULT_CHARS);
    expect(await processResult(exact, info)).toBe(exact);
  });

  it("keeps the start and the end of a long result and says how much was removed", async () => {
    const text = "A".repeat(1000) + "B".repeat(8000) + "C".repeat(1000);
    const out = await truncateStage(1000)(text, info);
    expect(out.startsWith("A".repeat(750))).toBe(true);
    expect(out.endsWith("C".repeat(250))).toBe(true);
    expect(out).toContain("9,000 characters removed");
    expect(out.length).toBeLessThan(text.length / 5);
  });

  it("caps a huge result at the default limit", async () => {
    const out = await processResult("x".repeat(MAX_RESULT_CHARS * 3), info);
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 300);
  });
});

describe("processResult", () => {
  it("runs the stages in order, each on the previous output, with the call's info", async () => {
    const seen: ResultInfo[] = [];
    const add = (s: string): ResultStage => (text, i) => {
      seen.push(i);
      return text + s;
    };
    expect(await processResult("a", info, [add("1"), add("2")])).toBe("a12");
    expect(seen).toEqual([info, info]);
  });

  it("waits for async stages", async () => {
    const slow: ResultStage = async (t) => t.toUpperCase();
    expect(await processResult("a", info, [slow])).toBe("A");
  });
});
