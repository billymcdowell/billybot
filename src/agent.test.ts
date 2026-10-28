import { beforeEach, describe, expect, it, vi } from "vitest";
import { call, fakeClient, recordingAsk, say, useTools, type Reply } from "./test/helpers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./storage", () => ({ getAlwaysAllowed: async () => [], addAlwaysAllowed: async () => {} }));

// The loop builds its own OpenAI client; hand it ours.
let client: ReturnType<typeof fakeClient>;
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (...a: unknown[]) => (client.create as (...x: unknown[]) => unknown)(...a) } };
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { runAgent, systemPrompt, textOf, toolsFor, type AgentOptions } from "./agent";
import type { Mode } from "./storage";

const invokeMock = vi.mocked(invoke);
type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;
/** Answers Tauri commands from `handlers`; anything else (e.g. a missing CLAUDE.md) rejects. */
function backend(handlers: Handlers = {}) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`no ${cmd}`);
    return h((args ?? {}) as Record<string, unknown>) as never;
  });
}

function options(over: Partial<AgentOptions> = {}, mode: Mode = "bypass"): AgentOptions {
  return {
    apiKey: "k",
    model: "m",
    workspace: "/ws",
    projects: [{ name: "app", writable: true }],
    getMode: () => mode,
    messages: [{ role: "user", content: "hi" }],
    ask: recordingAsk().ask,
    onUpdate: () => {},
    ...over,
  };
}

const run = (script: Reply[], over?: Partial<AgentOptions>, mode?: Mode, sub?: (t: string) => Reply) => {
  client = fakeClient(script, sub);
  return runAgent(options(over, mode));
};
const last = <T,>(a: T[]) => a[a.length - 1];
const toolResults = (msgs: { role: string; content?: unknown }[]) => msgs.filter((m) => m.role === "tool").map((m) => String(m.content));

beforeEach(() => backend());

describe("textOf", () => {
  it("handles strings, part lists and anything else", () => {
    expect(textOf("hi")).toBe("hi");
    expect(textOf([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }])).toBe("ab");
    expect(textOf(null)).toBe("");
  });
});

describe("toolsFor", () => {
  const names = (role?: "main" | "sub") => toolsFor(role).map((t) => ("function" in t ? t.function.name : ""));
  it("gives the main agent every tool, in a stable order", () => {
    expect(names("main")).toEqual([
      "list_projects", "open_project", "close_project", "create_project", "delegate_task",
      "run_command", "list_dir", "read_file", "write_file", "edit_file", "multi_edit", "grep", "glob",
    ]);
  });
  it("gives subagents only the file and search tools", () => {
    expect(names("sub")).toEqual(["list_dir", "read_file", "write_file", "edit_file", "multi_edit", "grep", "glob"]);
  });
});

describe("systemPrompt", () => {
  it("lists open projects for the main agent", () => {
    const p = systemPrompt({ role: "main", workspace: "/ws", projects: [{ name: "app", writable: false }] });
    expect(p).toContain("app (read-only)");
    expect(p).toContain("Workspace: /ws");
  });
  it("tells a subagent its one project", () => {
    expect(systemPrompt({ role: "sub", workspace: "/ws", projects: [{ name: "app", writable: true }] })).toContain('only in the project "app"');
  });
  it("adds project instructions", () => {
    const p = systemPrompt({ role: "main", workspace: "/ws", projects: [] }, [{ project: "app", text: "use tabs" }]);
    expect(p).toContain("app/CLAUDE.md");
    expect(p).toContain("use tabs");
  });
});

describe("runAgent", () => {
  it("returns a plain reply and reports usage", async () => {
    const onUsage = vi.fn();
    const out = await run([{ text: "hello", usage: { prompt: 10, completion: 2 } }], { onUsage });
    expect(last(out)).toEqual({ role: "assistant", content: "hello" });
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 2 });
  });

  it("sends the system prompt first and the tool definitions", async () => {
    await run([say("ok")]);
    expect(client.requests[0].messages[0].role).toBe("system");
    expect(client.requests[0].tools).toHaveLength(13);
  });

  it("runs a tool and sends its result back", async () => {
    backend({ read_lines: () => "file text" });
    const out = await run([useTools(call("read_file", { path: "app/a.txt" }, "c1")), say("done")]);
    expect(out[out.length - 2]).toEqual({ role: "tool", tool_call_id: "c1", content: "file text" });
    expect(invokeMock).toHaveBeenCalledWith("read_lines", { workspace: "/ws", project: "app", path: "a.txt", offset: undefined, limit: undefined });
  });

  it("explains a path outside the open projects", async () => {
    const out = await run([useTools(call("read_file", { path: "other/a.txt" })), say("ok")]);
    expect(toolResults(out)[0]).toMatch(/^Error: "other" is not open/);
  });

  it("refuses writes to a read-only project without asking", async () => {
    const { ask } = recordingAsk();
    const out = await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], {
      projects: [{ name: "app", writable: false }],
      ask,
    }, "ask");
    expect(toolResults(out)[0]).toMatch(/open read-only/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses commands in a read-only project and for subagents", async () => {
    const out = await run([useTools(call("run_command", { project: "app", command: "ls" })), say("ok")], {
      projects: [{ name: "app", writable: false }],
    });
    expect(toolResults(out)[0]).toMatch(/open read-only/);

  });

  it("stops a subagent from running commands or delegating", async () => {
    const replies = [
      useTools(call("run_command", { project: "app", command: "ls" }, "a"), call("delegate_task", { project: "app", task: "t" }, "b")),
      say("ok"),
    ];
    client = fakeClient([], () => replies.shift()!);
    const out = await runAgent(options({ role: "sub", who: "app agent" }));
    expect(toolResults(out)).toEqual(["Error: Subagents cannot run commands.", "Error: Subagents cannot delegate."]);
  });

  it("passes the old file text to the approval card for write_file", async () => {
    backend({ read_file: () => "old", write_file: () => "Wrote" });
    const { ask, asked } = recordingAsk("once");
    await run([useTools(call("write_file", { path: "app/a.txt", content: "new" })), say("ok")], { ask }, "ask");
    expect(asked[0]).toMatchObject({ tool: "write_file", where: "app", who: "Main agent", before: "old" });
  });

  it("tells the model when the user denies an action", async () => {
    backend({ write_file: () => "Wrote" });
    const { ask } = recordingAsk("deny");
    const out = await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { ask }, "ask");
    expect(toolResults(out)[0]).toBe("The user denied this action.");
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("turns a Rust error into a tool result", async () => {
    backend({ edit_file: () => { throw new Error("old_text was not found"); } });
    const out = await run([useTools(call("edit_file", { path: "app/a", old_text: "a", new_text: "b" })), say("ok")]);
    expect(toolResults(out)[0]).toBe("Error: old_text was not found");
  });

  it("reports an unknown tool and bad JSON arguments", async () => {
    const out = await run([useTools(call("nope", {}, "c1")), say("ok")]);
    expect(toolResults(out)[0]).toBe("Error: Unknown tool: nope");
  });

  it("does not start tool calls after Stop, but still answers each one", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await run([useTools(call("list_projects")), say("ok")], { signal: controller.signal });
    // The fake ignores the signal, so the loop reaches the tool; it must not run it.
    expect(toolResults(out)[0]).toBe("Cancelled: the user pressed Stop.");
  });

  it("stops a subagent from using project tools it was not given", async () => {
    const replies = [useTools(call("create_project", { name: "evil" }), call("open_project", { name: "x" }, "o")), say("ok")];
    client = fakeClient([], () => replies.shift()!);
    backend({ create_project: () => "evil", check_project: () => undefined });
    const out = await runAgent(options({ role: "sub", who: "app agent" }));
    expect(toolResults(out)).toEqual(["Error: Subagents cannot use create_project.", "Error: Subagents cannot use open_project."]);
    expect(invokeMock).not.toHaveBeenCalledWith("create_project", expect.anything());
  });

  it("cuts an enormous tool result down before it reaches the model", async () => {
    backend({ read_lines: () => "z".repeat(500_000) });
    const out = await run([useTools(call("read_file", { path: "app/big.txt" })), say("ok")]);
    const [result] = toolResults(out);
    expect(result.length).toBeLessThan(101_000);
    expect(result).toContain("characters removed");
  });

  it("opens, lists and closes projects", async () => {
    const onProjectsChange = vi.fn();
    backend({
      check_project: () => undefined,
      list_projects: () => [{ name: "app", modified: 0, summary: "An app" }],
    });
    const out = await run(
      [
        useTools(call("list_projects", {}, "a"), call("open_project", { name: "lib" }, "b"), call("close_project", { name: "app" }, "c")),
        say("ok"),
      ],
      { onProjectsChange },
    );
    const [list, opened, closed] = toolResults(out);
    expect(list).toContain("app [open] · changed 1970-01-01 · An app");
    expect(opened).toBe("Opened lib (read-only).");
    expect(closed).toBe("Closed app.");
  });

  it("limits how many projects are open", async () => {
    backend({ check_project: () => undefined });
    const out = await run([useTools(call("open_project", { name: "d" })), say("ok")], {
      projects: ["a", "b", "c"].map((name) => ({ name, writable: false })),
    });
    expect(toolResults(out)[0]).toMatch(/3 projects are already open/);
  });

  it("creates a project and opens it writable", async () => {
    backend({ create_project: () => "newapp", check_project: () => undefined });
    const out = await run([useTools(call("create_project", { name: "newapp" })), say("ok")]);
    expect(toolResults(out)[0]).toBe("Created newapp. Opened newapp (writable).");
  });

  it("runs a command in a writable project", async () => {
    backend({ run_command: () => "output" });
    const out = await run([useTools(call("run_command", { project: "app", command: "ls", timeout_seconds: 5 })), say("ok")]);
    expect(toolResults(out)[0]).toBe("output");
    expect(invokeMock).toHaveBeenCalledWith("run_command", {
      workspace: "/ws", project: "app", command: "ls", timeoutSeconds: 5,
      maxTimeoutSeconds: 300, headChars: 10_000, tailChars: 20_000,
    });
  });

  it("runs delegated tasks and caps them at three per turn", async () => {
    backend({ check_project: () => undefined });
    const calls = [1, 2, 3, 4].map((n) => call("delegate_task", { project: "app", task: `task ${n}` }, `d${n}`));
    const out = await run([useTools(...calls), say("ok")], {}, "bypass", (task) => say(`report for ${task}`));
    const results = toolResults(out);
    expect(results.filter((r) => r.startsWith("Report from the app agent:"))).toHaveLength(3);
    expect(results.filter((r) => r.startsWith("Refused: at most 3 subagents"))).toHaveLength(1);
  });

  it("stops a runaway loop after 25 steps", async () => {
    const out = await run(Array.from({ length: 30 }, () => useTools(call("list_projects"))));
    expect(last(out)).toEqual({ role: "assistant", content: "Stopped after 25 steps." });
    expect(client.create).toHaveBeenCalledTimes(25);
  });

  it("adds a project's CLAUDE.md to the system prompt", async () => {
    backend({ read_file: ({ path }) => { if (path === "CLAUDE.md") return "use tabs"; throw new Error("x"); } });
    await run([say("ok")]);
    expect(String(client.requests[0].messages[0].content)).toContain("use tabs");
  });
});

describe("file and search tools", () => {
  it("passes read_file's offset and limit through, ignoring values that aren't numbers", async () => {
    backend({ read_lines: () => "x" });
    await run([useTools(call("read_file", { path: "app/a.txt", offset: 50, limit: "lots" })), say("ok")]);
    expect(invokeMock).toHaveBeenCalledWith("read_lines", { workspace: "/ws", project: "app", path: "a.txt", offset: 50, limit: undefined });
  });

  it("sends grep's options to Rust and treats it as a read: no prompt, even read-only", async () => {
    backend({ grep_files: () => "app/a.ts:1: hit" });
    const { ask } = recordingAsk();
    const out = await run(
      [useTools(call("grep", { pattern: "hit", path: "app/src", glob: "*.ts", case_insensitive: true, context: 2, output: "files", max_results: 5 })), say("ok")],
      { ask, projects: [{ name: "app", writable: false }] },
      "readOnly",
    );
    expect(toolResults(out)[0]).toBe("app/a.ts:1: hit");
    expect(ask).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("grep_files", {
      workspace: "/ws", project: "app", path: "src", pattern: "hit", glob: "*.ts",
      caseInsensitive: true, context: 2, output: "files", maxResults: 5,
    });
  });

  it("sends glob's options to Rust and keeps it inside open projects", async () => {
    backend({ glob_files: () => "app/a.ts" });
    const out = await run([useTools(call("glob", { pattern: "*.ts", path: "app" }, "g1"), call("glob", { pattern: "*", path: "other" }, "g2")), say("ok")]);
    expect(invokeMock).toHaveBeenCalledWith("glob_files", { workspace: "/ws", project: "app", path: "", pattern: "*.ts", maxResults: undefined });
    expect(toolResults(out)[1]).toMatch(/^Error: "other" is not open/);
  });

  it("lets subagents search", async () => {
    backend({ grep_files: () => "No matches." });
    const replies = [useTools(call("grep", { pattern: "x", path: "app" })), say("ok")];
    client = fakeClient([], () => replies.shift()!);
    const out = await runAgent(options({ role: "sub", who: "app agent" }));
    expect(toolResults(out)).toEqual(["No matches."]);
  });

  it("applies a multi_edit as one write after one approval", async () => {
    backend({ read_file: () => "one two", multi_edit: () => "Made 2 edits to app/a.txt" });
    const { ask, asked } = recordingAsk("once");
    const edits = [{ old_text: "one", new_text: "1" }, { old_text: "two", new_text: "2" }];
    const out = await run([useTools(call("multi_edit", { path: "app/a.txt", edits })), say("ok")], { ask }, "ask");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "multi_edit", category: "write", before: "one two" });
    expect(invokeMock).toHaveBeenCalledWith("multi_edit", { workspace: "/ws", project: "app", path: "a.txt", edits });
    expect(toolResults(out)[0]).toBe("Made 2 edits to app/a.txt");
  });

  it("rejects a malformed multi_edit before asking the user anything", async () => {
    const { ask } = recordingAsk();
    const out = await run(
      [useTools(call("multi_edit", { path: "app/a.txt", edits: [{ old_text: "a" }] }, "m1"), call("multi_edit", { path: "app/a.txt", edits: [] }, "m2")), say("ok")],
      { ask },
      "ask",
    );
    expect(ask).not.toHaveBeenCalled();
    expect(toolResults(out)).toEqual([
      "Error: Edit 1 of 1 must have old_text and new_text as text.",
      "Error: edits must be a non-empty list of {old_text, new_text}.",
    ]);
  });

  it("refuses multi_edit in a read-only project and in read-only mode", async () => {
    const edits = [{ old_text: "a", new_text: "b" }];
    const ro = await run([useTools(call("multi_edit", { path: "app/a", edits })), say("ok")], { projects: [{ name: "app", writable: false }] });
    expect(toolResults(ro)[0]).toMatch(/open read-only/);
    const mode = await run([useTools(call("multi_edit", { path: "app/a", edits })), say("ok")], {}, "readOnly");
    expect(toolResults(mode)[0]).toMatch(/Read-only mode/);
  });
});

describe("limits", () => {
  it("uses the user's command limits", async () => {
    backend({ run_command: () => "ok" });
    await run([useTools(call("run_command", { project: "app", command: "ls" })), say("ok")], {
      limits: { defaultTimeoutSecs: 120, maxTimeoutSecs: 900, outputHeadChars: 1, outputTailChars: 2 },
    });
    expect(invokeMock).toHaveBeenCalledWith("run_command", expect.objectContaining({
      timeoutSeconds: 120, maxTimeoutSeconds: 900, headChars: 1, tailChars: 2,
    }));
  });

  it("uses the user's cap on tool results", async () => {
    backend({ read_lines: () => "q".repeat(20_000) });
    const out = await run([useTools(call("read_file", { path: "app/a" })), say("ok")], { limits: { maxResultChars: 5_000 } });
    expect(toolResults(out)[0].length).toBeLessThan(5_300);
  });
});

describe("Stop", () => {
  /** A model that streams some text and is then cut off by Stop. */
  function stoppedMidReply(controller: AbortController, partial: string, calls: object[] = []) {
    client = {
      requests: [],
      create: vi.fn(async () =>
        (async function* () {
          yield { choices: [{ delta: { content: partial } }] };
          for (const tc of calls) yield { choices: [{ delta: { tool_calls: [tc] } }] };
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })(),
      ),
    } as never;
  }

  it("keeps the text streamed so far and returns instead of throwing", async () => {
    const controller = new AbortController();
    stoppedMidReply(controller, "Let me look at");
    const out = await runAgent(options({ signal: controller.signal }));
    expect(last(out)).toEqual({ role: "assistant", content: "Let me look at" });
    expect(out).toHaveLength(2);
  });

  it("drops a half-streamed tool call, so nothing dangling is left", async () => {
    const controller = new AbortController();
    stoppedMidReply(controller, "", [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":"app/a' } }]);
    const out = await runAgent(options({ signal: controller.signal }));
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("still throws real errors", async () => {
    client = { requests: [], create: vi.fn(async () => { throw new Error("401 bad key"); }) } as never;
    await expect(runAgent(options())).rejects.toThrow("401 bad key");
  });

  it("marks a subagent that was running when Stop was pressed as stopped", async () => {
    backend({ check_project: () => undefined });
    const controller = new AbortController();
    const onSubagent = vi.fn();
    await run([useTools(call("delegate_task", { project: "app", task: "t" })), say("ok")], { onSubagent, signal: controller.signal }, "bypass", () => {
      controller.abort();
      return say("partial report");
    });
    expect(last(onSubagent.mock.calls)[1]).toMatchObject({ status: "stopped" });
  });
});
