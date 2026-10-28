import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => []);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));

import { changedByTurn, checkpointStatus, describePlan, filesFrom, previewRevert, revertRuns, runsFrom, summarizeRevert, type CheckpointRun, type FilePlan } from "./checkpoints";

const runs: CheckpointRun[] = [
  { run: "a", turn: 0 }, { run: "b", turn: 0 }, { run: "c", turn: 2 }, { run: "d", turn: 4 },
];

describe("changedByTurn", () => {
  it("adds up the files of every run in a turn and leaves out turns with none", () => {
    const status = [{ runId: "a", files: 2 }, { runId: "b", files: 1 }, { runId: "c", files: 0 }, { runId: "d", files: 5 }];
    expect(changedByTurn(runs, status)).toEqual({ "0": 3, "4": 5 });
    expect(changedByTurn(runs, [])).toEqual({});
    expect(changedByTurn([], status)).toEqual({});
  });
});

describe("runsFrom", () => {
  it("lists runs newest first, from a turn on", () => {
    expect(runsFrom(runs, 2)).toEqual(["d", "c"]);
    expect(runsFrom(runs, 0)).toEqual(["d", "c", "b", "a"]);
    expect(runsFrom(runs, 5)).toEqual([]);
  });
  it("can take just one turn", () => {
    expect(runsFrom(runs, 0, true)).toEqual(["b", "a"]);
    expect(runsFrom(runs, 2, true)).toEqual(["c"]);
    expect(runsFrom(runs, 3, true)).toEqual([]);
  });
});

describe("filesFrom", () => {
  it("counts the files changed from a turn on", () => {
    expect(filesFrom({ "0": 3, "4": 5 }, 0)).toBe(8);
    expect(filesFrom({ "0": 3, "4": 5 }, 1)).toBe(5);
    expect(filesFrom({ "0": 3, "4": 5 }, 5)).toBe(0);
    expect(filesFrom({}, 0)).toBe(0);
  });
});

describe("describePlan", () => {
  const p = (path: string, action: string): FilePlan => ({ runId: "a", project: "app", path, action });
  it("describes each file, hides the ones needing nothing, and counts conflicts", () => {
    const plan = [p("a.ts", "restore"), p("new.ts", "delete"), p("b.ts", "nothing"), p("c.ts", "conflict_changed"), p("d.ts", "conflict_missing"), p("e.ts", "blocked")];
    const s = describePlan(plan);
    expect(s.changes).toBe(2);
    expect(s.conflicts).toBe(3);
    expect(s.lines.map((l) => l.text)).toEqual([
      "app/a.ts: will be put back as it was",
      "app/new.ts: was created by the agent and will be deleted",
      "app/c.ts: changed since the agent wrote it",
      "app/d.ts: deleted since the agent wrote it",
      "app/e.ts: can't be reached safely, so it will be left alone",
    ]);
    expect(s.lines.map((l) => l.conflict)).toEqual([false, false, true, true, true]);
  });
  it("copes with an empty plan", () => {
    expect(describePlan([])).toEqual({ lines: [], changes: 0, conflicts: 0 });
  });
});

describe("summarizeRevert", () => {
  it("says what was done and what was left", () => {
    expect(summarizeRevert({ restored: 2, deleted: 1, skipped: [] })).toBe("Undone: restored 2 files and deleted 1 new file.");
    expect(summarizeRevert({ restored: 1, deleted: 0, skipped: ["app/a.ts: changed since the agent wrote it"] })).toBe(
      "Undone: restored 1 file. Left alone: app/a.ts: changed since the agent wrote it.",
    );
    expect(summarizeRevert({ restored: 0, deleted: 0, skipped: [] })).toBe("Nothing needed undoing.");
  });
});

describe("talking to Rust", () => {
  it("asks only when there are runs, and sends ids as Rust expects", async () => {
    invokeMock.mockClear();
    expect(await checkpointStatus("c1", [])).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
    await checkpointStatus("c1", runs);
    expect(invokeMock).toHaveBeenCalledWith("checkpoint_status", { chatId: "c1", runIds: ["a", "b", "c", "d"] });
    await previewRevert("c1", ["d"]);
    expect(invokeMock).toHaveBeenCalledWith("checkpoint_preview", { chatId: "c1", runIds: ["d"] });
    await revertRuns("c1", ["d"], true);
    expect(invokeMock).toHaveBeenCalledWith("checkpoint_revert", { chatId: "c1", runIds: ["d"], force: true });
  });
});
