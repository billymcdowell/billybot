import { invoke } from "@tauri-apps/api/core";

// The frontend side of undo. Rust keeps the copies (src-tauri/src/checkpoint.rs); this asks what
// can be undone, shows it, and tells Rust to do it.

/** A run that may have changed files, and the turn (index of your message) it answered. */
export type CheckpointRun = { run: string; turn: number };

export type FilePlan = {
  runId: string;
  project: string;
  path: string;
  /** restore, delete, nothing, conflict_changed, conflict_missing or blocked */
  action: string;
};

export type RevertResult = { restored: number; deleted: number; skipped: string[] };

/** Files changed per turn, from Rust's per-run counts. Turns with none are left out. */
export function changedByTurn(runs: CheckpointRun[], status: { runId: string; files: number }[]): Record<string, number> {
  const files = new Map(status.map((s) => [s.runId, s.files]));
  const out: Record<string, number> = {};
  for (const r of runs) {
    const n = files.get(r.run) ?? 0;
    if (n > 0) out[String(r.turn)] = (out[String(r.turn)] ?? 0) + n;
  }
  return out;
}

/** The runs for turns at or after `fromTurn` (or exactly `turn` when `only` is set), newest first: the order to undo them. */
export function runsFrom(runs: CheckpointRun[], fromTurn: number, only = false): string[] {
  return runs
    .filter((r) => (only ? r.turn === fromTurn : r.turn >= fromTurn))
    .map((r) => r.run)
    .reverse();
}

/** How many files changed in turns at or after `fromTurn`. */
export function filesFrom(changed: Record<string, number>, fromTurn: number): number {
  return Object.entries(changed).reduce((sum, [turn, n]) => sum + (Number(turn) >= fromTurn ? n : 0), 0);
}

const WORDS: Record<string, string> = {
  restore: "will be put back as it was",
  delete: "was created by the agent and will be deleted",
  nothing: "already as it was",
  conflict_changed: "changed since the agent wrote it",
  conflict_missing: "deleted since the agent wrote it",
  blocked: "can't be reached safely, so it will be left alone",
};

export type PlanSummary = {
  lines: { text: string; conflict: boolean }[];
  changes: number; // files that will be restored or deleted without any trouble
  conflicts: number; // files that changed since, or can't be reached
};

/** The plan as lines for the confirmation dialog. */
export function describePlan(plan: FilePlan[]): PlanSummary {
  const lines = plan
    .filter((p) => p.action !== "nothing")
    .map((p) => ({ text: `${p.project}/${p.path}: ${WORDS[p.action] ?? p.action}`, conflict: p.action.startsWith("conflict") || p.action === "blocked" }));
  return {
    lines,
    changes: plan.filter((p) => p.action === "restore" || p.action === "delete").length,
    conflicts: lines.filter((l) => l.conflict).length,
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One sentence about what a revert did. */
export function summarizeRevert(r: RevertResult): string {
  const done = [r.restored ? `restored ${plural(r.restored, "file")}` : "", r.deleted ? `deleted ${plural(r.deleted, "new file")}` : ""].filter(Boolean);
  const head = done.length ? `Undone: ${done.join(" and ")}.` : "Nothing needed undoing.";
  return r.skipped.length ? `${head} Left alone: ${r.skipped.join("; ")}.` : head;
}

export const checkpointStatus = (chatId: string, runs: CheckpointRun[]) =>
  runs.length === 0
    ? Promise.resolve([])
    : invoke<{ runId: string; files: number }[]>("checkpoint_status", { chatId, runIds: runs.map((r) => r.run) });

export const previewRevert = (chatId: string, runIds: string[]) => invoke<FilePlan[]>("checkpoint_preview", { chatId, runIds });

export const revertRuns = (chatId: string, runIds: string[], force: boolean) =>
  invoke<RevertResult>("checkpoint_revert", { chatId, runIds, force });
