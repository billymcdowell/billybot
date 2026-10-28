import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingAsk } from "./test/helpers";

// The real storage is a Tauri plugin; this keeps "always allow" in memory.
const allowed = new Map<string, string[]>();
vi.mock("./storage", () => ({
  getAlwaysAllowed: async (scope: string) => allowed.get(scope) ?? [],
  addAlwaysAllowed: async (scope: string, tool: string) => {
    allowed.set(scope, [...(allowed.get(scope) ?? []), tool]);
  },
}));

import { checkPermission, type ApprovalRequest, type ToolCategory } from "./permissions";

const CATEGORY: Record<string, ToolCategory> = {
  list_dir: "read", read_file: "read", list_projects: "read",
  open_project: "meta", close_project: "meta", delegate_task: "meta",
  write_file: "write", edit_file: "write", create_project: "write",
  run_command: "command",
};
const req = (tool: string): ApprovalRequest => ({ tool, category: CATEGORY[tool], args: {}, who: "Main agent", where: "proj" });
const SCOPE = "/ws/proj";

beforeEach(() => allowed.clear());

describe("checkPermission", () => {
  it.each(["list_dir", "read_file", "list_projects", "open_project", "close_project", "delegate_task"])(
    "never asks for %s, in any mode",
    async (tool) => {
      for (const mode of ["ask", "acceptEdits", "readOnly", "bypass"] as const) {
        const { ask } = recordingAsk();
        expect(await checkPermission(req(tool), mode, SCOPE, ask)).toBeNull();
        expect(ask).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["write_file", "edit_file", "create_project", "run_command"])("read-only mode refuses %s", async (tool) => {
    const { ask } = recordingAsk();
    expect(await checkPermission(req(tool), "readOnly", SCOPE, ask)).toMatch(/Read-only/);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["write_file", "edit_file", "create_project", "run_command"])("bypass allows %s without asking", async (tool) => {
    const { ask } = recordingAsk();
    expect(await checkPermission(req(tool), "bypass", SCOPE, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("auto-accept allows edits without asking but still asks for commands", async () => {
    const edit = recordingAsk();
    expect(await checkPermission(req("edit_file"), "acceptEdits", SCOPE, edit.ask)).toBeNull();
    expect(edit.ask).not.toHaveBeenCalled();

    const cmd = recordingAsk();
    expect(await checkPermission(req("run_command"), "acceptEdits", SCOPE, cmd.ask)).toBeNull();
    expect(cmd.ask).toHaveBeenCalledOnce();
  });

  it("ask mode asks, and a denial comes back as a message for the model", async () => {
    const { ask } = recordingAsk("deny");
    expect(await checkPermission(req("write_file"), "ask", SCOPE, ask)).toBe("The user denied this action.");
  });

  it("'always' is remembered per scope for edits", async () => {
    const first = recordingAsk("always");
    expect(await checkPermission(req("edit_file"), "ask", SCOPE, first.ask)).toBeNull();

    const again = recordingAsk();
    expect(await checkPermission(req("edit_file"), "ask", SCOPE, again.ask)).toBeNull();
    expect(again.ask).not.toHaveBeenCalled();

    // Another tool, or another project, still asks.
    const otherTool = recordingAsk();
    await checkPermission(req("write_file"), "ask", SCOPE, otherTool.ask);
    expect(otherTool.ask).toHaveBeenCalledOnce();
    const otherScope = recordingAsk();
    await checkPermission(req("edit_file"), "ask", "/ws/other", otherScope.ask);
    expect(otherScope.ask).toHaveBeenCalledOnce();
  });

  it("'always' is never remembered for commands", async () => {
    const first = recordingAsk("always");
    expect(await checkPermission(req("run_command"), "ask", SCOPE, first.ask)).toBeNull();
    expect(allowed.get(SCOPE)).toBeUndefined();

    const again = recordingAsk();
    await checkPermission(req("run_command"), "ask", SCOPE, again.ask);
    expect(again.ask).toHaveBeenCalledOnce();
  });
});
