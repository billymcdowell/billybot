import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "./limits";

describe("resolveLimits", () => {
  it("fills in defaults", () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({ maxResultChars: 50_000 })).toEqual({ ...DEFAULT_LIMITS, maxResultChars: 50_000 });
  });

  it("clamps to the bounds and rounds", () => {
    const l = resolveLimits({ maxTimeoutSecs: 99_999, outputHeadChars: -5, maxResultChars: 10, defaultTimeoutSecs: 30.6 });
    expect(l).toMatchObject({ maxTimeoutSecs: 3600, outputHeadChars: 0, maxResultChars: 5_000, defaultTimeoutSecs: 31 });
  });

  it("ignores values that aren't finite numbers", () => {
    expect(resolveLimits({ maxResultChars: NaN, outputTailChars: "x" as unknown as number })).toEqual(DEFAULT_LIMITS);
  });

  it("never lets the default timeout exceed the maximum", () => {
    const l = resolveLimits({ defaultTimeoutSecs: 600, maxTimeoutSecs: 120 });
    expect(l.defaultTimeoutSecs).toBe(120);
  });

  it("keeps cents on the budget and treats 0 as off", () => {
    expect(resolveLimits({ budgetUsd: 2.456 }).budgetUsd).toBe(2.46);
    expect(resolveLimits({ budgetUsd: -4 }).budgetUsd).toBe(0);
    expect(resolveLimits({ budgetUsd: 99_999 }).budgetUsd).toBe(1000);
    expect(DEFAULT_LIMITS.budgetUsd).toBe(0);
  });
});

describe("undo copy limits", () => {
  it("default to 30 days and 500 MB and stay within bounds", () => {
    expect(DEFAULT_LIMITS).toMatchObject({ checkpointDays: 30, checkpointMb: 500 });
    expect(resolveLimits({ checkpointDays: 0, checkpointMb: 1 })).toMatchObject({ checkpointDays: 1, checkpointMb: 50 });
    expect(resolveLimits({ checkpointDays: 9999, checkpointMb: 999_999 })).toMatchObject({ checkpointDays: 365, checkpointMb: 20_000 });
  });
});

describe("running chats at once", () => {
  it("defaults to 4 and stays between 1 and 16", () => {
    expect(DEFAULT_LIMITS.maxConcurrentRuns).toBe(4);
    expect(resolveLimits({ maxConcurrentRuns: 0 }).maxConcurrentRuns).toBe(1);
    expect(resolveLimits({ maxConcurrentRuns: 99 }).maxConcurrentRuns).toBe(16);
    expect(resolveLimits({ maxConcurrentRuns: 2.6 }).maxConcurrentRuns).toBe(3);
  });
});

describe("when to summarize", () => {
  it("defaults to 80% of the window and stays between 30 and 95", () => {
    expect(DEFAULT_LIMITS.compactAtPercent).toBe(80);
    expect(resolveLimits({ compactAtPercent: 5 }).compactAtPercent).toBe(30);
    expect(resolveLimits({ compactAtPercent: 100 }).compactAtPercent).toBe(95);
    expect(resolveLimits({ compactAtPercent: 72.4 }).compactAtPercent).toBe(72);
  });
});
