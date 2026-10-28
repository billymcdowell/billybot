import { describe, expect, it } from "vitest";
import { addUsage, budgetState, effectiveCap, emptyUsage, formatCost, priceRequest, type UsageEvent } from "./cost";

const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  model: "m", role: "main", who: "Main agent", promptTokens: 1000, completionTokens: 500, ...over,
});
const PRICE = { inputPerM: 3, outputPerM: 15 };

describe("priceRequest", () => {
  it("trusts the cost OpenRouter reported, even when it is zero", () => {
    expect(priceRequest(ev({ cost: 0.0123 }), PRICE)).toEqual({ cost: 0.0123, estimated: false });
    expect(priceRequest(ev({ cost: 0 }), PRICE)).toEqual({ cost: 0, estimated: false });
  });

  it("works it out from the listed prices when none was reported", () => {
    // 1000 * $3/M + 500 * $15/M = 0.003 + 0.0075
    expect(priceRequest(ev(), PRICE)?.cost).toBeCloseTo(0.0105);
    expect(priceRequest(ev(), PRICE)?.estimated).toBe(true);
  });

  it("gives up when the price is unknown, varies, or the cost is nonsense", () => {
    expect(priceRequest(ev())).toBeNull();
    expect(priceRequest(ev(), { inputPerM: -1, outputPerM: -1 })).toBeNull();
    expect(priceRequest(ev({ cost: -5 }), undefined)).toBeNull();
    expect(priceRequest(ev({ cost: NaN }), undefined)).toBeNull();
  });
});

describe("addUsage", () => {
  it("adds up cost, tokens and requests, and tracks each turn", () => {
    let u = emptyUsage();
    u = addUsage(u, ev({ cost: 0.01 }), PRICE, 0);
    u = addUsage(u, ev({ cost: 0.02, promptTokens: 10, completionTokens: 5 }), PRICE, 0);
    u = addUsage(u, ev({ cost: 0.5 }), PRICE, 4);
    expect(u.cost).toBeCloseTo(0.53);
    expect(u).toMatchObject({ promptTokens: 2010, completionTokens: 1005, requests: 3, estimated: 0, unpriced: 0 });
    expect(u.turns["0"]).toBeCloseTo(0.03);
    expect(u.turns["4"]).toBeCloseTo(0.5);
  });

  it("counts estimated and unpriced requests, and does not change the old total", () => {
    const before = emptyUsage();
    const a = addUsage(before, ev(), PRICE, 0);
    const b = addUsage(a, ev(), undefined, 0);
    expect(before.requests).toBe(0);
    expect(a).toMatchObject({ estimated: 1, unpriced: 0 });
    expect(b).toMatchObject({ estimated: 1, unpriced: 1, requests: 2 });
    expect(b.cost).toBeCloseTo(a.cost);
  });
});

describe("formatCost", () => {
  it("shows more digits for tiny amounts", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0043)).toBe("$0.0043");
    expect(formatCost(0.0105)).toBe("$0.01");
    expect(formatCost(1.2749)).toBe("$1.27");
  });
});

describe("budget", () => {
  it("adds what was granted for this chat to the setting, and is off when the setting is off", () => {
    expect(effectiveCap(5, 2)).toBe(7);
    expect(effectiveCap(0, 2)).toBe(0);
    expect(effectiveCap(5, -3)).toBe(5);
  });

  it("warns at 80% and stops at the cap", () => {
    expect(budgetState(100, 0)).toBe("off");
    expect(budgetState(3.9, 5)).toBe("ok");
    expect(budgetState(4, 5)).toBe("warn");
    expect(budgetState(4.99, 5)).toBe("warn");
    expect(budgetState(5, 5)).toBe("over");
    expect(budgetState(9, 5)).toBe("over");
  });
});
