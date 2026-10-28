// Limits on commands and tool results. The user can change them in the header's Limits menu.

export type Limits = {
  defaultTimeoutSecs: number; // how long a command may run when the model doesn't say
  maxTimeoutSecs: number; // the most the model may ask for
  outputHeadChars: number; // how much of the start of a command's output is kept
  outputTailChars: number; // ...and of the end
  maxResultChars: number; // the most any one tool result may send to the model
  budgetUsd: number; // the most one chat may spend, in dollars; 0 means no limit
  checkpointDays: number; // how long undo copies of the agent's file changes are kept
  checkpointMb: number; // ...and how much room they may take
  maxConcurrentRuns: number; // chats that may have an agent working at once; more wait for a free slot
};

export const DEFAULT_LIMITS: Limits = {
  defaultTimeoutSecs: 60,
  maxTimeoutSecs: 300,
  outputHeadChars: 10_000,
  outputTailChars: 20_000,
  maxResultChars: 100_000,
  budgetUsd: 0,
  checkpointDays: 30,
  checkpointMb: 500,
  maxConcurrentRuns: 4,
};

// [min, max] for each. The Rust side enforces the same ceilings.
export const LIMIT_BOUNDS: Record<keyof Limits, [number, number]> = {
  defaultTimeoutSecs: [1, 3600],
  maxTimeoutSecs: [1, 3600],
  outputHeadChars: [0, 200_000],
  outputTailChars: [0, 200_000],
  maxResultChars: [5_000, 400_000],
  budgetUsd: [0, 1000],
  checkpointDays: [1, 365],
  checkpointMb: [50, 20_000],
  maxConcurrentRuns: [1, 16],
};

/** Fills in anything missing, clamps every value to its bounds, and keeps the default timeout under the maximum. */
export function resolveLimits(saved?: Partial<Limits>): Limits {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = saved?.[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const [min, max] = LIMIT_BOUNDS[key];
      // dollars keep cents; everything else is a whole number
      const rounded = key === "budgetUsd" ? Math.round(v * 100) / 100 : Math.round(v);
      out[key] = Math.min(max, Math.max(min, rounded));
    }
  }
  out.defaultTimeoutSecs = Math.min(out.defaultTimeoutSecs, out.maxTimeoutSecs);
  return out;
}
