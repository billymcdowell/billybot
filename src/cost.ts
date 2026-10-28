// What the chat has cost. OpenRouter reports the real cost of each request when asked; when it
// doesn't, the cost is worked out from the model's listed prices.

export type UsageEvent = {
  model: string;
  role: "main" | "sub";
  who: string;
  promptTokens: number;
  completionTokens: number;
  cost?: number; // US dollars, as reported by OpenRouter
  callId?: string; // for a subagent: the delegate_task call that started it
};

export type ChatUsage = {
  cost: number; // dollars spent in this chat, including turns that were later regenerated
  promptTokens: number;
  completionTokens: number;
  requests: number;
  estimated: number; // requests whose cost was worked out from prices, not reported
  unpriced: number; // requests with no known cost, so the total is a lower bound
  turns: Record<string, number>; // cost of each turn, keyed by the index of the user message that started it
};

export type ModelPrice = { inputPerM: number; outputPerM: number };

export const emptyUsage = (): ChatUsage => ({
  cost: 0, promptTokens: 0, completionTokens: 0, requests: 0, estimated: 0, unpriced: 0, turns: {},
});

/** The cost of one request, or null if it can't be known. Negative prices mean "varies" (router models). */
export function priceRequest(ev: UsageEvent, price?: ModelPrice): { cost: number; estimated: boolean } | null {
  if (typeof ev.cost === "number" && Number.isFinite(ev.cost) && ev.cost >= 0) return { cost: ev.cost, estimated: false };
  if (!price || !(price.inputPerM >= 0) || !(price.outputPerM >= 0)) return null;
  const cost = (ev.promptTokens * price.inputPerM + ev.completionTokens * price.outputPerM) / 1_000_000;
  return Number.isFinite(cost) ? { cost, estimated: true } : null;
}

/** A new total with this request added. `turn` is the index of the user message the request belongs to. */
export function addUsage(u: ChatUsage, ev: UsageEvent, price: ModelPrice | undefined, turn: number): ChatUsage {
  const priced = priceRequest(ev, price);
  const key = String(turn);
  return {
    cost: u.cost + (priced?.cost ?? 0),
    promptTokens: u.promptTokens + (ev.promptTokens || 0),
    completionTokens: u.completionTokens + (ev.completionTokens || 0),
    requests: u.requests + 1,
    estimated: u.estimated + (priced?.estimated ? 1 : 0),
    unpriced: u.unpriced + (priced ? 0 : 1),
    turns: priced ? { ...u.turns, [key]: (u.turns[key] ?? 0) + priced.cost } : u.turns,
  };
}

/** "$0.00", "$0.0043", "$1.27" */
export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export type BudgetState = "off" | "ok" | "warn" | "over";

/** The cap for one chat: the setting plus anything added for this chat. 0 means no cap. */
export const effectiveCap = (setting: number, extra = 0) => (setting > 0 ? setting + Math.max(0, extra) : 0);

export function budgetState(spent: number, cap: number): BudgetState {
  if (!(cap > 0)) return "off";
  if (spent >= cap) return "over";
  return spent >= cap * 0.8 ? "warn" : "ok";
}
