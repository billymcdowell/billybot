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

import { checkPermission, MODES, nextMode, type ApprovalRequest, type ToolCategory } from "./permissions";

const CATEGORY: Record<string, ToolCategory> = {
  list_dir: "read", read_file: "read", list_projects: "read",
  open_project: "meta", close_project: "meta", delegate_task: "meta",
  write_file: "write", edit_file: "write", create_project: "write",
  run_command: "command", git_commit: "git", fetch_url: "network",
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

describe("dangerous commands", () => {
  const risky: ApprovalRequest = { ...req("run_command"), danger: "This command runs with administrator rights." };

  it("ask even in Bypass mode", async () => {
    const { ask, asked } = recordingAsk("once");
    expect(await checkPermission(risky, "bypass", SCOPE, ask)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0].danger).toContain("administrator");
  });

  it("can be denied there", async () => {
    expect(await checkPermission(risky, "bypass", SCOPE, recordingAsk("deny").ask)).toBe("The user denied this action.");
  });

  it("are never remembered, and still refused in read-only mode", async () => {
    await checkPermission(risky, "bypass", SCOPE, recordingAsk("always").ask);
    expect(allowed.get(SCOPE)).toBeUndefined();
    const { ask } = recordingAsk();
    expect(await checkPermission(risky, "readOnly", SCOPE, ask)).toMatch(/Read-only/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("do not change how an ordinary command behaves in Bypass", async () => {
    const { ask } = recordingAsk();
    expect(await checkPermission(req("run_command"), "bypass", SCOPE, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("plan mode", () => {
  it.each(["write_file", "edit_file", "create_project", "run_command", "git_commit"])("refuses %s, and says what to do instead", async (tool) => {
    const { ask } = recordingAsk();
    const result = await checkPermission(req(tool), "plan", SCOPE, ask);
    expect(result).toMatch(/^Plan mode is on/);
    expect(result).toMatch(/approve/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("still lets the agent read", async () => {
    const { ask } = recordingAsk();
    for (const tool of ["list_dir", "read_file", "open_project", "delegate_task"]) {
      expect(await checkPermission(req(tool), "plan", SCOPE, ask)).toBeNull();
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses even a flagged command", async () => {
    expect(await checkPermission({ ...req("run_command"), danger: "x" }, "plan", SCOPE, recordingAsk().ask)).toMatch(/^Plan mode/);
  });
});

describe("git and network tools", () => {
  it.each(["git_commit", "fetch_url"])("%s asks in Ask, Auto-accept and Plan-compatible modes, and is never remembered", async (tool) => {
    for (const mode of ["ask", "acceptEdits"] as const) {
      const { ask } = recordingAsk("always");
      expect(await checkPermission(req(tool), mode, SCOPE, ask)).toBeNull();
      expect(ask).toHaveBeenCalledOnce();
    }
    expect(allowed.get(SCOPE)).toBeUndefined();
  });

  it.each(["git_commit", "fetch_url"])("%s runs without asking only in Bypass, and is refused in Read-only", async (tool) => {
    const bypass = recordingAsk();
    expect(await checkPermission(req(tool), "bypass", SCOPE, bypass.ask)).toBeNull();
    expect(bypass.ask).not.toHaveBeenCalled();
    expect(await checkPermission(req(tool), "readOnly", SCOPE, recordingAsk().ask)).toMatch(/Read-only/);
  });

  it("lets network lookups be asked about in Plan mode, but not git", async () => {
    const { ask } = recordingAsk("once");
    expect(await checkPermission(req("fetch_url"), "plan", SCOPE, ask)).toBeNull();
    expect(ask).toHaveBeenCalledOnce();
    expect(await checkPermission(req("git_commit"), "plan", SCOPE, recordingAsk().ask)).toMatch(/^Plan mode/);
  });
});

describe("the modes list", () => {
  it("has every mode once, with a hint", () => {
    expect(MODES.map((m) => m.id)).toEqual(["ask", "acceptEdits", "plan", "readOnly", "bypass"]);
    for (const m of MODES) expect(m.hint.length).toBeGreaterThan(10);
  });

  it("Shift+Tab steps through the safe modes only, and gets back to them from the others", () => {
    expect(nextMode("ask")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("plan");
    expect(nextMode("plan")).toBe("ask");
    expect(nextMode("bypass")).toBe("ask");
    expect(nextMode("readOnly")).toBe("ask");
  });
});
