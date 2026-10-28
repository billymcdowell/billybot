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
});
