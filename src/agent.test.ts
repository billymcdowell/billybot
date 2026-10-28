import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
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
      "run_command", "list_dir", "read_file", "write_file", "edit_file", "multi_edit", "grep", "glob", "todo_write", "ask_user",
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
    const out = await run([{ text: "hello", usage: { prompt: 10, completion: 2, cost: 0.004 } }], { onUsage });
    expect(last(out)).toEqual({ role: "assistant", content: "hello" });
    expect(onUsage).toHaveBeenCalledWith({
      model: "m", role: "main", who: "Main agent", promptTokens: 10, completionTokens: 2, cost: 0.004,
    });
  });

  it("sends the system prompt first and the tool definitions", async () => {
    await run([say("ok")]);
    expect(client.requests[0].messages[0].role).toBe("system");
    expect(client.requests[0].tools).toHaveLength(15);
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

describe("cost and budget", () => {
  it("asks OpenRouter to report each request's cost", async () => {
    await run([say("ok")]);
    expect(client.create.mock.calls[0][0]).toMatchObject({ usage: { include: true }, stream: true });
  });

  it("reports a subagent's requests too, labelled as the subagent's", async () => {
    backend({ check_project: () => undefined });
    const onUsage = vi.fn();
    const sub = (): Reply => ({ text: "report", usage: { prompt: 5, completion: 1, cost: 0.002 } });
    await run([useTools(call("delegate_task", { project: "app", task: "t" })), { text: "ok", usage: { prompt: 9, completion: 3, cost: 0.01 } }], { onUsage }, "bypass", sub);
    const events = onUsage.mock.calls.map((c) => c[0]);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ role: "sub", who: "app agent", cost: 0.002 }));
    expect(events).toContainEqual(expect.objectContaining({ role: "main", cost: 0.01 }));
  });

  it("stops at once, without calling the model, if the chat is already over its cap", async () => {
    const out = await run([say("never reached")], { overBudget: () => 5 });
    expect(last(out)).toEqual({ role: "assistant", content: "Stopped: this chat reached its budget of $5.00." });
    expect(client.create).not.toHaveBeenCalled();
  });

  it("checks between steps, so a long task is cut off part-way", async () => {
    let calls = 0;
    backend({ list_projects: () => [] });
    const out = await run(
      [useTools(call("list_projects")), useTools(call("list_projects")), say("never reached")],
      { overBudget: () => (++calls > 2 ? 1 : null) },
    );
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(last(out)).toMatchObject({ role: "assistant", content: expect.stringContaining("budget of $1.00") });
  });
});

describe("messages sent while the agent works", () => {
  it("joins them to the conversation before the next request", async () => {
    const queue = ["also add tests"];
    backend({ list_projects: () => [] });
    const out = await run([useTools(call("list_projects")), say("ok")], { takeSteering: () => queue.splice(0) });
    // asked before each step after the first, so the text lands after the first step's tool result
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(out[3]).toEqual({ role: "user", content: "also add tests" });
    const second = client.requests[1].messages.map((m) => m.role);
    expect(second.slice(-2)).toEqual(["tool", "user"]);
  });

  it("is not offered to subagents", async () => {
    backend({ check_project: () => undefined });
    const takeSteering = vi.fn(() => ["steer"]);
    await run([useTools(call("delegate_task", { project: "app", task: "t" })), say("ok")], { takeSteering });
    // asked before the main agent's second step only: not before its first, and never for the subagent
    expect(takeSteering).toHaveBeenCalledTimes(1);
  });
});

describe("secrets", () => {
  const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

  it("hides secrets in a tool result from the model", async () => {
    backend({ read_lines: () => `OPENROUTER_API_KEY=${KEY}\nPORT=3000` });
    const out = await run([useTools(call("read_file", { path: "app/.env" })), say("ok")]);
    expect(toolResults(out)[0]).toBe("OPENROUTER_API_KEY=[REDACTED:api-key]\nPORT=3000");
    expect(JSON.stringify(client.requests[1].messages)).not.toContain("0123456789abcdef");
  });

  it("hides them in command output too", async () => {
    backend({ run_command: () => `Exit code 0\nexport AWS=AKIAIOSFODNN7EXAMPLE` });
    const out = await run([useTools(call("run_command", { project: "app", command: "env" })), say("ok")]);
    expect(toolResults(out)[0]).toContain("[REDACTED:aws-key]");
  });

  it("leaves results alone when redaction is off", async () => {
    backend({ read_lines: () => KEY });
    const out = await run([useTools(call("read_file", { path: "app/a" })), say("ok")], { redact: false });
    expect(toolResults(out)[0]).toBe(KEY);
  });

  it("refuses to write a placeholder back, before asking the user anything", async () => {
    const { ask } = recordingAsk();
    const edits = [{ old_text: "a", new_text: "TOKEN=[REDACTED:env-secret]" }];
    const out = await run(
      [
        useTools(
          call("write_file", { path: "app/.env", content: "TOKEN=[REDACTED:env-secret]" }, "w"),
          call("edit_file", { path: "app/.env", old_text: "[REDACTED:api-key]", new_text: "x" }, "e"),
          call("multi_edit", { path: "app/.env", edits }, "m"),
        ),
        say("ok"),
      ],
      { ask },
      "ask",
    );
    expect(ask).not.toHaveBeenCalled();
    expect(toolResults(out)).toHaveLength(3);
    for (const r of toolResults(out)) expect(r).toMatch(/^Error: Refused: the text contains a \[REDACTED/);
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("allows placeholders when redaction is off, and ordinary text that merely mentions the word", async () => {
    backend({ write_file: () => "Wrote", read_file: () => "" });
    const out = await run(
      [useTools(call("write_file", { path: "app/a", content: "[REDACTED:x]" }, "w1"), call("write_file", { path: "app/b", content: "REDACTED is a word" }, "w2")), say("ok")],
      { redact: false },
    );
    expect(toolResults(out)).toEqual(["Wrote", "Wrote"]);
    const normal = await run([useTools(call("write_file", { path: "app/b", content: "REDACTED is a word" })), say("ok")]);
    expect(toolResults(normal)[0]).toBe("Wrote");
  });
});

describe("the dangerous-command guard", () => {
  it("makes a flagged command ask even in Bypass, and shows why", async () => {
    backend({ run_command: () => "Exit code 0" });
    const { ask, asked } = recordingAsk("once");
    const out = await run([useTools(call("run_command", { project: "app", command: "git push --force" })), say("ok")], { ask }, "bypass");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "run_command", mode: "bypass" });
    expect(asked[0].danger).toMatch(/force-pushes/);
    expect(toolResults(out)[0]).toBe("Exit code 0");
  });

  it("does not run it if you say no", async () => {
    backend({ run_command: () => "Exit code 0" });
    const out = await run([useTools(call("run_command", { project: "app", command: "rm -rf ~" })), say("ok")], { ask: recordingAsk("deny").ask }, "bypass");
    expect(toolResults(out)[0]).toBe("The user denied this action.");
    expect(invokeMock).not.toHaveBeenCalledWith("run_command", expect.anything());
  });

  it("leaves ordinary commands alone in Bypass", async () => {
    backend({ run_command: () => "Exit code 0" });
    const { ask } = recordingAsk();
    await run([useTools(call("run_command", { project: "app", command: "npm test" })), say("ok")], { ask }, "bypass");
    expect(ask).not.toHaveBeenCalled();
  });

  it("warns when a command contains a key, without forcing a prompt in Bypass", async () => {
    backend({ run_command: () => "Exit code 0" });
    const { ask } = recordingAsk();
    await run([useTools(call("run_command", { project: "app", command: "curl -H 'Authorization: sk-or-v1-0123456789abcdef0123456789abcdef' x" })), say("ok")], { ask }, "bypass");
    expect(ask).not.toHaveBeenCalled();
    const { ask: ask2, asked } = recordingAsk();
    await run([useTools(call("run_command", { project: "app", command: "echo sk-or-v1-0123456789abcdef0123456789abcdef" })), say("ok")], { ask: ask2 }, "ask");
    expect(asked[0].warning).toMatch(/key or password/);
  });
});

describe("activity events", () => {
  const collect = () => {
    const events: import("./activity").ActivityDraft[] = [];
    return { events, onEvent: (e: import("./activity").ActivityDraft) => void events.push(e) };
  };
  const byRef = (events: import("./activity").ActivityDraft[], ref: string) => events.filter((e) => e.ref === ref);

  it("logs each request: asked, then answered with tokens, cost and timing", async () => {
    const { events, onEvent } = collect();
    await run([{ text: "hi", usage: { prompt: 120, completion: 8, cost: 0.003 } }], { onEvent });
    const requests = events.filter((e) => e.category === "request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ pending: true, summary: "Asking m (step 1)", who: "Main agent", depth: 0 });
    expect(requests[1].ref).toBe(requests[0].ref);
    expect(requests[1]).toMatchObject({ summary: "m replied: 2 characters of text" });
    expect(requests[1].detail).toMatchObject({ inputTokens: 120, outputTokens: 8, cost: 0.003, textChars: 2 });
    expect(requests[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs a tool call as a running row that is replaced by its outcome", async () => {
    backend({ read_lines: () => "file text" });
    const { events, onEvent } = collect();
    await run([useTools(call("read_file", { path: "app/a.ts" }, "t1")), say("ok")], { onEvent });
    const rows = byRef(events, "t1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ category: "tool", pending: true, summary: "read_file path=app/a.ts" });
    expect(rows[1]).toMatchObject({ category: "tool", level: "info", summary: "read_file path=app/a.ts → ok, 9 chars" });
    expect(rows[1].detail).toMatchObject({ decision: "auto", status: "ok", resultChars: 9, sentToModelChars: 9, preview: "file text" });
  });

  it("never puts file contents in the log", async () => {
    backend({ write_file: () => "Wrote", read_file: () => "" });
    const { events, onEvent } = collect();
    await run([useTools(call("write_file", { path: "app/a.ts", content: "SECRET BODY ".repeat(50) }, "w")), say("ok")], { onEvent });
    expect(JSON.stringify(events)).not.toContain("SECRET BODY");
    expect(byRef(events, "w")[1].summary).toContain("content=(600 chars)");
  });

  it("notes when a result was changed on its way to the model", async () => {
    backend({ read_lines: () => "TOKEN=abc123\n" + "x".repeat(200_000) });
    const { events, onEvent } = collect();
    await run([useTools(call("read_file", { path: "app/.env" }, "t1")), say("ok")], { onEvent });
    const done = byRef(events, "t1")[1];
    expect(done.detail!.changes).toEqual(["redacted 1 secret", expect.stringContaining("truncated")]);
    expect(done.detail!.resultChars).toBeGreaterThan(200_000);
    expect(done.detail!.sentToModelChars).toBeLessThan(101_000);
  });

  it("records an approval: waiting, then your answer and how long it took", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    const { events, onEvent } = collect();
    await run([useTools(call("write_file", { path: "app/a", content: "x" }, "t1")), say("ok")], { onEvent, ask: recordingAsk("once").ask }, "ask");
    const approval = byRef(events, "approval-t1");
    expect(approval).toHaveLength(2);
    expect(approval[0]).toMatchObject({ category: "approval", pending: true, summary: "Waiting for your approval: write_file" });
    expect(approval[1]).toMatchObject({ summary: "You approved: write_file", level: "info" });
    expect(approval[1].detail).toMatchObject({ tool: "write_file", mode: "ask" });
    expect(typeof approval[1].detail!.waitedMs).toBe("number");
    expect(byRef(events, "t1")[1].detail).toMatchObject({ decision: "approved" });
  });

  it("records a denial, and a refusal that never asked", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    const denied = collect();
    await run([useTools(call("write_file", { path: "app/a", content: "x" }, "t1")), say("ok")], { onEvent: denied.onEvent, ask: recordingAsk("deny").ask }, "ask");
    expect(byRef(denied.events, "approval-t1")[1]).toMatchObject({ level: "warn", summary: "You denied: write_file" });
    expect(byRef(denied.events, "t1")[1]).toMatchObject({ level: "warn", summary: expect.stringContaining("you denied it") });

    const refused = collect();
    await run([useTools(call("write_file", { path: "app/a", content: "x" }, "t2")), say("ok")], { onEvent: refused.onEvent }, "readOnly");
    expect(byRef(refused.events, "approval-t2")).toHaveLength(0);
    expect(byRef(refused.events, "t2")[1]).toMatchObject({ level: "warn", summary: expect.stringContaining("refused") });
    expect(byRef(refused.events, "t2")[1].detail).toMatchObject({ decision: "refused", status: "refused" });
  });

  it("logs commands with their exit code, and flags dangerous ones", async () => {
    backend({ run_command: () => "Exit code 2\nboom" });
    const { events, onEvent } = collect();
    await run([useTools(call("run_command", { project: "app", command: "sudo make" }, "c1")), say("ok")], { onEvent, ask: recordingAsk("once").ask }, "bypass");
    const done = byRef(events, "c1")[1];
    expect(done).toMatchObject({ category: "command", level: "warn", summary: expect.stringContaining("→ exit 2") });
    expect(done.detail).toMatchObject({ exitCode: 2, decision: "approved" });
    expect(done.detail!.flagged).toMatch(/administrator/);
    expect(byRef(events, "approval-c1")[0].level).toBe("warn");
  });

  it("logs errors", async () => {
    const { events, onEvent } = collect();
    await run([useTools(call("nope", {}, "t1")), say("ok")], { onEvent });
    expect(last(byRef(events, "t1"))).toMatchObject({ level: "error", summary: expect.stringContaining("Unknown tool: nope") });
  });

  it("logs a failed request and rethrows", async () => {
    client = { requests: [], create: vi.fn(async () => { throw new Error("401 bad key"); }) } as never;
    const { events, onEvent } = collect();
    await expect(runAgent(options({ onEvent }))).rejects.toThrow("401 bad key");
    expect(events[events.length - 1]).toMatchObject({ category: "request", level: "error", summary: "Request to m failed: 401 bad key" });
  });

  it("logs a subagent's work nested under it", async () => {
    backend({ check_project: () => undefined, list_dir: () => ["a.ts"] });
    const { events, onEvent } = collect();
    const replies = [useTools(call("list_dir", { path: "app" }, "s1")), say("all done")];
    await run([useTools(call("delegate_task", { project: "app", task: "look around" }, "d1")), say("ok")], { onEvent }, "bypass", () => replies.shift()!);
    const sub = byRef(events, "subagent-d1");
    expect(sub[0]).toMatchObject({ category: "subagent", pending: true, summary: "Subagent for app: look around", who: "Main agent" });
    expect(sub[1]).toMatchObject({ summary: "Subagent for app done", level: "info" });
    const inner = byRef(events, "s1");
    expect(inner[0]).toMatchObject({ who: "app agent", depth: 1 });
    const requests = events.filter((e) => e.category === "request" && e.who === "app agent");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((e) => e.depth === 1)).toBe(true);
  });

  it("logs a budget stop, a step limit and a steering message", async () => {
    const budget = collect();
    await run([say("never")], { onEvent: budget.onEvent, overBudget: () => 2 });
    expect(budget.events[0]).toMatchObject({ category: "chat", level: "warn", summary: expect.stringContaining("$2.00 budget") });

    backend({ list_projects: () => [] });
    const limit = collect();
    await run(Array.from({ length: 30 }, () => useTools(call("list_projects"))), { onEvent: limit.onEvent });
    expect(limit.events.filter((e) => e.category === "chat")[0]).toMatchObject({ level: "warn", summary: "Stopped after 25 steps (the limit for one run)" });

    const steer = collect();
    const queue = ["also add tests"];
    await run([useTools(call("list_projects")), say("ok")], { onEvent: steer.onEvent, takeSteering: () => queue.splice(0) });
    expect(steer.events.find((e) => e.category === "chat")).toMatchObject({ summary: "A message you queued joined the run", detail: { text: "also add tests" } });
  });

  it("logs a cancelled request when you press Stop", async () => {
    const controller = new AbortController();
    client = {
      requests: [],
      create: vi.fn(async () => (async function* () { yield { choices: [{ delta: { content: "par" } }] }; controller.abort(); throw new DOMException("Aborted", "AbortError"); })()),
    } as never;
    const { events, onEvent } = collect();
    await runAgent(options({ onEvent, signal: controller.signal }));
    expect(events[events.length - 1]).toMatchObject({ category: "request", level: "warn", summary: "Request to m cancelled", detail: { charsReceived: 3 } });
  });
});

describe("plan mode", () => {
  it("tells the model it is planning, only while the mode is Plan", async () => {
    await run([say("a plan")], {}, "plan");
    expect(String(client.requests[0].messages[0].content)).toContain("PLAN MODE is on");
    await run([say("done")], {}, "ask");
    expect(String(client.requests[0].messages[0].content)).not.toContain("PLAN MODE");
    expect(systemPrompt({ role: "sub", workspace: "/ws", projects: [{ name: "app", writable: true }], getMode: () => "plan" })).not.toContain("PLAN MODE");
  });

  it("refuses changes and commands but lets it read and search", async () => {
    backend({ read_lines: () => "text", grep_files: () => "app/a:1: hit", write_file: () => "Wrote", run_command: () => "Exit code 0" });
    const { ask } = recordingAsk();
    const out = await run(
      [useTools(
        call("read_file", { path: "app/a" }, "r"), call("grep", { pattern: "x", path: "app" }, "g"),
        call("write_file", { path: "app/a", content: "x" }, "w"), call("run_command", { project: "app", command: "ls" }, "c"),
      ), say("my plan")],
      { ask }, "plan",
    );
    const results = toolResults(out);
    expect(results.slice(0, 2)).toEqual(["text", "app/a:1: hit"]);
    expect(results[2]).toMatch(/^Plan mode is on/);
    expect(results[3]).toMatch(/^Plan mode is on/);
    expect(ask).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("notices a mode change between steps", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null, list_projects: () => [] });
    let mode: Mode = "plan";
    client = fakeClient([useTools(call("list_projects")), useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")]);
    const out = await runAgent({ ...options(), getMode: () => mode, onUpdate: (m) => { if (m.length === 3) mode = "bypass"; } });
    expect(String(client.requests[0].messages[0].content)).toContain("PLAN MODE");
    expect(String(client.requests[1].messages[0].content)).not.toContain("PLAN MODE");
    expect(toolResults(out)[1]).toBe("Wrote");
  });
});

describe("undo copies", () => {
  it("sends the run to Rust with every file change", async () => {
    backend({ write_file: () => "Wrote", edit_file: () => "Edited", multi_edit: () => "Made", read_file: () => null });
    const checkpoint = { chatId: "chat1", runId: "run1" };
    const edits = [{ old_text: "a", new_text: "b" }];
    await run(
      [useTools(
        call("write_file", { path: "app/a", content: "x" }, "w"), call("edit_file", { path: "app/a", old_text: "a", new_text: "b" }, "e"),
        call("multi_edit", { path: "app/a", edits }, "m"),
      ), say("ok")],
      { checkpoint },
    );
    for (const cmd of ["write_file", "edit_file", "multi_edit"]) {
      expect(invokeMock).toHaveBeenCalledWith(cmd, expect.objectContaining({ checkpoint }));
    }
  });

  it("gives a subagent's writes to the same run", async () => {
    backend({ check_project: () => undefined, write_file: () => "Wrote", read_file: () => null });
    const checkpoint = { chatId: "chat1", runId: "run1" };
    const replies = [useTools(call("write_file", { path: "app/a", content: "x" })), say("done")];
    await run([useTools(call("delegate_task", { project: "app", task: "t" })), say("ok")], { checkpoint }, "bypass", () => replies.shift()!);
    expect(invokeMock).toHaveBeenCalledWith("write_file", expect.objectContaining({ checkpoint }));
  });

  it("tells the model when Rust could not make a copy, as an ordinary error", async () => {
    backend({ write_file: () => { throw new Error("Couldn't keep an undo copy, so nothing was changed: disk full"); }, read_file: () => null });
    const out = await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { checkpoint: { chatId: "c", runId: "r" } });
    expect(toolResults(out)[0]).toMatch(/^Error: Couldn't keep an undo copy, so nothing was changed/);
  });
});

describe("before a file change", () => {
  it("tells the app which project is about to change, once per change, after approval", async () => {
    backend({ write_file: () => "Wrote", edit_file: () => "Edited", read_file: () => null, read_lines: () => "x" });
    const beforeWrite = vi.fn(async (_p: string) => {});
    const { ask } = recordingAsk("once");
    await run(
      [useTools(call("read_file", { path: "app/a" }, "r"), call("write_file", { path: "app/a", content: "x" }, "w"), call("edit_file", { path: "app/b", old_text: "a", new_text: "b" }, "e")), say("ok")],
      { beforeWrite, ask }, "ask",
    );
    expect(beforeWrite.mock.calls).toEqual([["app"], ["app"]]);
  });

  it("is not called when the change is denied or refused", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    const beforeWrite = vi.fn(async (_p: string) => {});
    await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { beforeWrite, ask: recordingAsk("deny").ask }, "ask");
    await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { beforeWrite }, "plan");
    expect(beforeWrite).not.toHaveBeenCalled();
  });

  it("never stops the change if it fails", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    const out = await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { beforeWrite: async () => { throw new Error("git exploded"); } });
    expect(toolResults(out)[0]).toBe("Wrote");
  });

  it("is not called for creating a project, which has no project yet", async () => {
    backend({ create_project: () => "newapp", check_project: () => undefined });
    const beforeWrite = vi.fn(async (_p: string) => {});
    await run([useTools(call("create_project", { name: "newapp" })), say("ok")], { beforeWrite });
    expect(beforeWrite).not.toHaveBeenCalled();
  });
});

describe("reading in parallel", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("runs neighbouring reads together and still adds their results in the order they were asked for", async () => {
    let live = 0;
    let peak = 0;
    const slow = (ms: number, out: string) => async () => {
      live++;
      peak = Math.max(peak, live);
      await delay(ms);
      live--;
      return out;
    };
    const timings: Record<string, ReturnType<ReturnType<typeof slow>>> = {};
    void timings;
    backend({
      read_lines: ({ path }) => (path === "a" ? slow(40, "A")() : path === "b" ? slow(5, "B")() : slow(20, "C")()),
    });
    const started = Date.now();
    const out = await run([useTools(call("read_file", { path: "app/a" }, "1"), call("read_file", { path: "app/b" }, "2"), call("read_file", { path: "app/c" }, "3")), say("ok")]);
    expect(peak).toBe(3);
    expect(Date.now() - started).toBeLessThan(90); // not 40 + 5 + 20 one after another
    expect(toolResults(out)).toEqual(["A", "B", "C"]);
    expect(out.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(["1", "2", "3"]);
  });

  it("treats a write as a barrier: reads before it finish first, reads after it start afterwards", async () => {
    const log: string[] = [];
    backend({
      read_lines: async ({ path }) => { log.push(`start ${path}`); await delay(10); log.push(`end ${path}`); return String(path); },
      write_file: async () => { log.push("write"); return "Wrote"; },
      read_file: () => null,
    });
    await run([useTools(
      call("read_file", { path: "app/a" }, "1"), call("read_file", { path: "app/b" }, "2"),
      call("write_file", { path: "app/w", content: "x" }, "3"),
      call("read_file", { path: "app/c" }, "4"), call("read_file", { path: "app/d" }, "5"),
    ), say("ok")]);
    expect(log.indexOf("write")).toBeGreaterThan(log.indexOf("end a"));
    expect(log.indexOf("write")).toBeGreaterThan(log.indexOf("end b"));
    expect(log.indexOf("start c")).toBeGreaterThan(log.indexOf("write"));
    expect(log.indexOf("start d")).toBeGreaterThan(log.indexOf("write"));
    expect(log.indexOf("start d")).toBeLessThan(log.indexOf("end c")); // c and d overlap
  });

  it("one failing read doesn't stop the others", async () => {
    backend({
      read_lines: async ({ path }) => { if (path === "bad") throw new Error("no such file"); return `ok ${path}`; },
    });
    const out = await run([useTools(call("read_file", { path: "app/a" }, "1"), call("read_file", { path: "app/bad" }, "2"), call("read_file", { path: "app/c" }, "3")), say("ok")]);
    expect(toolResults(out)).toEqual(["ok a", "Error: no such file", "ok c"]);
  });

  it("mixes kinds of reads, runs no more than eight at once, and answers every call", async () => {
    let live = 0;
    let peak = 0;
    backend({
      read_lines: async () => { live++; peak = Math.max(peak, live); await delay(5); live--; return "x"; },
      grep_files: async () => { live++; peak = Math.max(peak, live); await delay(5); live--; return "g"; },
      list_dir: async () => ["f"],
    });
    const calls = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? call("grep", { pattern: "x", path: "app" }, `c${i}`) : i % 3 === 1 ? call("read_file", { path: "app/a" }, `c${i}`) : call("list_dir", { path: "app" }, `c${i}`)));
    const out = await run([useTools(...calls), say("ok")]);
    expect(toolResults(out)).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("still asks about a change one at a time", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    let asking = 0;
    let most = 0;
    const ask = vi.fn(async () => { asking++; most = Math.max(most, asking); await delay(5); asking--; return "once" as const; });
    await run([useTools(call("write_file", { path: "app/a", content: "1" }, "1"), call("write_file", { path: "app/b", content: "2" }, "2")), say("ok")], { ask }, "ask");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it("doesn't start reads after Stop but answers each one", async () => {
    const controller = new AbortController();
    controller.abort();
    backend({ read_lines: () => "x" });
    const out = await run([useTools(call("read_file", { path: "app/a" }, "1"), call("read_file", { path: "app/b" }, "2")), say("ok")], { signal: controller.signal });
    expect(toolResults(out)).toEqual(["Cancelled: the user pressed Stop.", "Cancelled: the user pressed Stop."]);
  });
});

describe("the to-do list", () => {
  it("replaces the list each time and tells the model how it stands", async () => {
    const onTodos = vi.fn();
    const items = [{ content: "Read the code", status: "completed" }, { content: "Fix the bug", status: "in_progress" }, { content: "Add a test", status: "pending" }];
    const out = await run([useTools(call("todo_write", { items })), say("ok")], { onTodos });
    expect(onTodos).toHaveBeenCalledWith(items);
    expect(toolResults(out)[0]).toBe("Todo list updated: 1 of 3 done. Working on: Fix the bug");
  });

  it("can clear the list, and says when everything is done", async () => {
    const onTodos = vi.fn();
    const cleared = await run([useTools(call("todo_write", { items: [] })), say("ok")], { onTodos });
    expect(toolResults(cleared)[0]).toBe("Todo list cleared.");
    const finished = await run([useTools(call("todo_write", { items: [{ content: "a", status: "completed" }] })), say("ok")], { onTodos });
    expect(toolResults(finished)[0]).toBe("Todo list updated: 1 of 1 done. All done.");
  });

  it("explains what is wrong with a bad list and changes nothing", async () => {
    const onTodos = vi.fn();
    const bad = (items: unknown) => run([useTools(call("todo_write", { items })), say("ok")], { onTodos }).then(toolResults);
    expect((await bad([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }]))[0]).toMatch(/Only one item can be in_progress/);
    expect((await bad([{ content: "a", status: "doing" }]))[0]).toMatch(/status "doing"/);
    expect((await bad([{ content: "  ", status: "pending" }]))[0]).toMatch(/needs some content/);
    expect((await bad("not a list"))[0]).toMatch(/must be a list/);
    expect((await bad(Array.from({ length: 31 }, () => ({ content: "x", status: "pending" }))))[0]).toMatch(/At most 30/);
    expect((await bad([{ content: "x".repeat(201), status: "pending" }]))[0]).toMatch(/longer than 200/);
    expect(onTodos).not.toHaveBeenCalled();
  });

  it("is for the main agent only, and is allowed in Plan mode", async () => {
    const replies = [useTools(call("todo_write", { items: [] })), say("ok")];
    client = fakeClient([], () => replies.shift()!);
    const sub = await runAgent(options({ role: "sub", who: "app agent" }));
    expect(toolResults(sub)).toEqual(["Error: Subagents cannot use todo_write."]);
    const plan = await run([useTools(call("todo_write", { items: [{ content: "a", status: "pending" }] })), say("ok")], {}, "plan");
    expect(toolResults(plan)[0]).toMatch(/^Todo list updated/);
  });
});

describe("asking the user", () => {
  it("waits for the answer and passes it back", async () => {
    const askUser = vi.fn(async () => "Use Postgres");
    const out = await run([useTools(call("ask_user", { question: "Which database?", options: ["Postgres", "SQLite"] })), say("ok")], { askUser });
    expect(askUser).toHaveBeenCalledWith({ question: "Which database?", options: ["Postgres", "SQLite"] });
    expect(toolResults(out)[0]).toBe("The user answered: Use Postgres");
  });

  it("tells the model when the run was stopped before an answer, and when there is no one to ask", async () => {
    const stopped = await run([useTools(call("ask_user", { question: "Sure?" })), say("ok")], { askUser: async () => null });
    expect(toolResults(stopped)[0]).toBe("The user didn't answer (the run was stopped).");
    const nobody = await run([useTools(call("ask_user", { question: "Sure?" })), say("ok")]);
    expect(toolResults(nobody)[0]).toMatch(/can't be asked right now/);
  });

  it("checks the question and the options", async () => {
    const askUser = vi.fn(async () => "x");
    const attempt = (args: object) => run([useTools(call("ask_user", args)), say("ok")], { askUser }).then(toolResults);
    expect((await attempt({ question: "  " }))[0]).toMatch(/must not be empty/);
    expect((await attempt({ question: "x".repeat(601) }))[0]).toMatch(/under 600/);
    expect((await attempt({ question: "q", options: "a, b" }))[0]).toMatch(/options must be a list/);
    expect((await attempt({ question: "q", options: ["a", ""] }))[0]).toMatch(/options must be a list/);
    expect((await attempt({ question: "q", options: ["x".repeat(121)] }))[0]).toMatch(/options must be a list/);
    expect(askUser).not.toHaveBeenCalled();
    await attempt({ question: " q ", options: [" a ", "b", "c", "d", "e", "f", "g", "h"] });
    expect(askUser).toHaveBeenCalledWith({ question: "q", options: ["a", "b", "c", "d", "e", "f"] });
  });

  it("is asked one at a time even when the model asks several together, alongside reads", async () => {
    backend({ read_lines: () => "text" });
    let waiting = 0;
    let most = 0;
    const askUser = vi.fn(async (q: { question: string }) => {
      waiting++;
      most = Math.max(most, waiting);
      await new Promise((r) => setTimeout(r, 5));
      waiting--;
      return `a to ${q.question}`;
    });
    const out = await run([useTools(call("read_file", { path: "app/a" }, "r"), call("ask_user", { question: "one" }, "q1"), call("ask_user", { question: "two" }, "q2")), say("ok")], { askUser });
    expect(most).toBe(1);
    expect(toolResults(out)).toEqual(["text", "The user answered: a to one", "The user answered: a to two"]);
  });

  it("is for the main agent only, and works in Plan mode", async () => {
    const replies = [useTools(call("ask_user", { question: "q" })), say("ok")];
    client = fakeClient([], () => replies.shift()!);
    const sub = await runAgent(options({ role: "sub", who: "app agent", askUser: async () => "x" }));
    expect(toolResults(sub)).toEqual(["Error: Subagents cannot use ask_user."]);
    const plan = await run([useTools(call("ask_user", { question: "q" })), say("ok")], { askUser: async () => "yes" }, "plan");
    expect(toolResults(plan)[0]).toBe("The user answered: yes");
  });

  it("hides secrets in the answer from the model like anything else", async () => {
    const out = await run([useTools(call("ask_user", { question: "key?" })), say("ok")], { askUser: async () => "it is sk-or-v1-0123456789abcdef0123456789abcdef" });
    expect(toolResults(out)[0]).not.toContain("0123456789abcdef");
  });
});

describe("telling the model about the list and questions", () => {
  it("is in the main agent's instructions and not the subagent's", () => {
    const main = systemPrompt({ role: "main", workspace: "/ws", projects: [] });
    expect(main).toContain("todo_write");
    expect(main).toContain("ask_user");
    const sub = systemPrompt({ role: "sub", workspace: "/ws", projects: [{ name: "app", writable: true }] });
    expect(sub).not.toContain("todo_write");
  });
});

describe("stopping one subagent", () => {
  it("ends only that subagent: the main agent carries on and is told what happened", async () => {
    backend({ check_project: () => undefined });
    const stops = new Map<string, () => void>();
    const registerSubagent = vi.fn((id: string, stop: (() => void) | null) => void (stop ? stops.set(id, stop) : stops.delete(id)));
    const onSubagent = vi.fn();
    const mainSignal = new AbortController();
    // the subagent asks the model for a reply; while it is "thinking", the user stops just that subagent
    const out = await run(
      [useTools(call("delegate_task", { project: "app", task: "do it" }, "d1")), say("carrying on without it")],
      { registerSubagent, onSubagent, signal: mainSignal.signal },
      "bypass",
      () => { stops.get("d1")!(); return say("half a thought"); },
    );
    expect(registerSubagent).toHaveBeenCalledWith("d1", expect.any(Function));
    expect(registerSubagent).toHaveBeenLastCalledWith("d1", null);
    expect(mainSignal.signal.aborted).toBe(false);
    expect(last(onSubagent.mock.calls)[1]).toMatchObject({ status: "stopped" });
    expect(toolResults(out)[0]).toBe("Report from the app agent:\nStopped by the user before it finished. What it had said so far: half a thought");
    expect(last(out)).toEqual({ role: "assistant", content: "carrying on without it" });
  });

  it("pressing Stop for the whole run stops its subagents too, and cleans up", async () => {
    backend({ check_project: () => undefined });
    const registerSubagent = vi.fn();
    const onSubagent = vi.fn();
    const controller = new AbortController();
    await run(
      [useTools(call("delegate_task", { project: "app", task: "t" })), say("ok")],
      { registerSubagent, onSubagent, signal: controller.signal },
      "bypass",
      () => { controller.abort(); return say("partial"); },
    );
    expect(last(onSubagent.mock.calls)[1].status).toBe("stopped");
    expect(registerSubagent).toHaveBeenLastCalledWith(expect.any(String), null);
  });

  it("records when it started and ended, and what it was saying as it went", async () => {
    backend({ check_project: () => undefined });
    const onSubagent = vi.fn();
    await run([useTools(call("delegate_task", { project: "app", task: "t" }, "d1")), say("ok")], { onSubagent }, "bypass", () => say("done"));
    const states = onSubagent.mock.calls.map((c) => c[1]);
    expect(states[0]).toMatchObject({ status: "running", startedAt: expect.any(Number) });
    const final = last(states);
    expect(final).toMatchObject({ status: "done", report: "done", streaming: "" });
    expect(final.endedAt).toBeGreaterThanOrEqual(final.startedAt);
  });

  it("tags its usage and its approval requests with the subagent that made them", async () => {
    backend({ check_project: () => undefined, write_file: () => "Wrote", read_file: () => null });
    const onUsage = vi.fn();
    const { ask, asked } = recordingAsk("once");
    const replies: Reply[] = [{ ...useTools(call("write_file", { path: "app/a", content: "x" })), usage: { prompt: 5, completion: 1, cost: 0.002 } }, say("done")];
    await run([useTools(call("delegate_task", { project: "app", task: "t" }, "d1")), say("ok")], { onUsage, ask }, "ask", () => replies.shift()!);
    expect(onUsage.mock.calls.map((c) => c[0]).find((u) => u.role === "sub")).toMatchObject({ callId: "d1", cost: 0.002 });
    expect(onUsage.mock.calls.map((c) => c[0]).find((u) => u.role === "main")?.callId).toBeUndefined();
    expect(asked[0]).toMatchObject({ tool: "write_file", owner: "d1", who: "app agent" });
  });

  it("the main agent's own approvals have no owner", async () => {
    backend({ write_file: () => "Wrote", read_file: () => null });
    const { ask, asked } = recordingAsk("once");
    await run([useTools(call("write_file", { path: "app/a", content: "x" })), say("ok")], { ask }, "ask");
    expect(asked[0].owner).toBeUndefined();
  });
});

describe("making room in a long conversation", () => {
  const long = (n: number): Msg[] => {
    const out: Msg[] = [{ role: "user", content: "big job" }];
    for (let i = 0; i < n; i++) {
      out.push({ role: "assistant", content: null, tool_calls: [{ id: `h${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      out.push({ role: "tool", tool_call_id: `h${i}`, content: `result ${i}` });
    }
    return out;
  };
  const compactTo = (upTo: number) => ({ upTo, summary: "Earlier work summarized.", at: 1 });

  it("asks for a summary when the last request filled enough of the window, and sends the summary instead of the old messages", async () => {
    const compact = vi.fn(async () => compactTo(9));
    const history = long(6); // 13 messages
    client = fakeClient([{ ...useTools(call("list_projects")), usage: { prompt: 17_000, completion: 5 } }, say("done")]);
    backend({ list_projects: () => [] });
    await runAgent(options({ messages: history, compact, contextWindow: 20_000, compactAt: 0.8 }));
    // first request: nothing is known yet, and a short history is far from full
    expect(compact).toHaveBeenCalledTimes(1);
    const second = client.requests[1].messages;
    expect(second[0].role).toBe("system");
    expect(String(second[1].content)).toContain("Earlier work summarized.");
    expect(second).toHaveLength(1 + 1 + (history.length + 2 - 9)); // system + summary + the messages from the cut on
    expect(JSON.stringify(second)).not.toContain("result 0");
    expect(JSON.stringify(second)).toContain("result 5");
  });

  it("doesn't ask while there is plenty of room", async () => {
    const compact = vi.fn(async () => compactTo(3));
    client = fakeClient([{ ...useTools(call("list_projects")), usage: { prompt: 5_000, completion: 5 } }, { ...say("done"), usage: { prompt: 6_000, completion: 5 } }]);
    backend({ list_projects: () => [] });
    await runAgent(options({ compact, contextWindow: 20_000 }));
    expect(compact).not.toHaveBeenCalled();
  });

  it("estimates when it has no usage figure yet, so a chat that is already huge is compacted before its first request", async () => {
    const compact = vi.fn(async () => compactTo(2));
    const history: Msg[] = [{ role: "user", content: "x".repeat(40_000) }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }];
    client = fakeClient([say("done")]);
    await runAgent(options({ messages: history, compact, contextWindow: 10_000 }));
    expect(compact).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.requests[0].messages)).not.toContain("xxxxxxxx");
  });

  it("uses a compaction it was given from the start, without asking again", async () => {
    const compact = vi.fn(async () => null);
    const history = long(4);
    client = fakeClient([say("done")]);
    await runAgent(options({ messages: history, compaction: compactTo(5), compact, contextWindow: 1_000_000 }));
    expect(String(client.requests[0].messages[1].content)).toContain("Earlier work summarized.");
    expect(client.requests[0].messages).toHaveLength(1 + 1 + (history.length - 5));
  });

  it("keeps the full history in what it returns", async () => {
    const history = long(6);
    client = fakeClient([say("done")]);
    const out = await runAgent(options({ messages: history, compaction: compactTo(9), contextWindow: 1_000_000 }));
    expect(out.slice(0, history.length)).toEqual(history);
    expect(last(out)).toEqual({ role: "assistant", content: "done" });
  });

  it("doesn't keep trying every step when there's nothing worth summarizing", async () => {
    const compact = vi.fn(async () => null);
    client = fakeClient([
      { ...useTools(call("list_projects")), usage: { prompt: 19_000, completion: 1 } },
      { ...useTools(call("list_projects")), usage: { prompt: 19_000, completion: 1 } },
      { ...useTools(call("list_projects")), usage: { prompt: 19_000, completion: 1 } },
      say("done"),
    ]);
    backend({ list_projects: () => [] });
    await runAgent(options({ compact, contextWindow: 20_000 }));
    expect(compact.mock.calls.length).toBeLessThanOrEqual(2);
    expect(compact.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("is for the main agent only", async () => {
    const compact = vi.fn(async () => compactTo(2));
    const replies = [say("done")];
    client = fakeClient([], () => replies.shift()!);
    await runAgent(options({ role: "sub", who: "app agent", messages: long(10), compact, contextWindow: 100 }));
    expect(compact).not.toHaveBeenCalled();
  });

  it("does nothing when it can't know the window", async () => {
    const compact = vi.fn(async () => compactTo(2));
    client = fakeClient([say("done")]);
    await runAgent(options({ messages: long(10), compact }));
    expect(compact).not.toHaveBeenCalled();
  });

  it("tells subagents nothing about it, even when the main agent has a compaction", async () => {
    backend({ check_project: () => undefined });
    const compact = vi.fn(async () => compactTo(2));
    await run([useTools(call("delegate_task", { project: "app", task: "t" })), say("ok")], { compact, contextWindow: 10, compaction: compactTo(0) }, "bypass", () => say("done"));
    const subRequest = client.requests.find((r) => String(r.messages[0].content).includes("You are a subagent"))!;
    expect(JSON.stringify(subRequest.messages)).not.toContain("summarized to save space");
  });
});
