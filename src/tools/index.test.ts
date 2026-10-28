import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { getTool, TOOLS, toolsFor } from "./index";

describe("tool registry", () => {
  it("has unique names, and each definition carries its own name", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.definition.type === "function" && t.definition.function.name).toBe(t.name);
      expect(getTool(t.name)).toBe(t);
    }
    expect(getTool("nope")).toBeUndefined();
  });

  it("gives every tool at least one role", () => {
    for (const t of TOOLS) expect(t.roles.length).toBeGreaterThan(0);
  });

  it("only marks tools parallel-safe when they are read-only and never prompt", () => {
    const safe = TOOLS.filter((t) => t.parallelSafe).map((t) => t.name);
    expect(safe).toEqual(["list_projects", "list_dir", "read_file", "grep", "glob"]);
    for (const t of TOOLS.filter((t) => t.parallelSafe)) expect(t.category).toBe("read");
  });

  it("file edits and commands check their project before the permission prompt", () => {
    for (const t of TOOLS.filter((t) => ["write_file", "edit_file", "run_command", "list_dir", "read_file"].includes(t.name))) {
      expect(t.target).toBeTypeOf("function");
    }
  });

  it("hands a subagent only the tools its role allows", () => {
    const names = (r: "main" | "sub") => toolsFor(r).map((t) => (t.type === "function" ? t.function.name : ""));
    expect(names("sub")).toEqual(TOOLS.filter((t) => t.roles.includes("sub")).map((t) => t.name));
    expect(names("sub")).not.toContain("run_command");
    expect(names("sub")).not.toContain("delegate_task");
    expect(toolsFor()).toEqual(toolsFor("main"));
  });
});
