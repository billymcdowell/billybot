import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { emptyUsage } from "./cost";
import { chatToJson, chatToMarkdown, exportFileName } from "./exportChat";
import type { Conversation } from "./storage";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const call = (id: string, name: string, args: object): Msg => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

const chat = (messages: Msg[], over: Partial<Conversation> = {}): Conversation => ({
  id: "c1", title: "Fix the bug", updatedAt: 0, messages, projects: [{ name: "app", writable: true }], subagents: {}, ...over,
});
const opts = { fullToolOutput: false, date: new Date("2026-10-28T12:00:00Z") };

describe("chatToMarkdown", () => {
  const messages: Msg[] = [
    { role: "user", content: "Read the file" },
    call("t1", "read_file", { path: "app/a.ts" }),
    { role: "tool", tool_call_id: "t1", content: "const x = 1;" },
    { role: "assistant", content: "It sets x." },
  ];

  it("writes a title, a summary line, and each turn", () => {
    const md = chatToMarkdown(chat(messages, { usage: { ...emptyUsage(), requests: 2, cost: 0.1234 } }), opts);
    expect(md).toContain("# Fix the bug");
    expect(md).toContain("*Exported 2026-10-28 · Projects: app (writable) · Cost: $0.12*");
    expect(md).toContain("## You\n\nRead the file");
    expect(md).toContain("<summary>read_file app/a.ts</summary>");
    expect(md).toContain("const x = 1;");
    expect(md).toContain("## Assistant\n\nIt sets x.");
  });

  it("marks a cost that is a lower bound", () => {
    const md = chatToMarkdown(chat(messages, { usage: { ...emptyUsage(), requests: 2, cost: 1, unpriced: 1 } }), opts);
    expect(md).toContain("Cost: $1.00+");
  });

  it("keeps secrets out of messages, tool calls and results", () => {
    const md = chatToMarkdown(
      chat([
        { role: "user", content: `my key is ${KEY}` },
        call("t1", "run_command", { command: `curl -H "Authorization: ${KEY}"` }),
        { role: "tool", tool_call_id: "t1", content: "DB_PASSWORD=hunter2" },
      ]),
      opts,
    );
    expect(md).not.toContain("0123456789abcdef");
    expect(md).not.toContain("hunter2");
    expect(md).toContain("[REDACTED:api-key]");
  });

  it("cuts long tool output unless asked for all of it", () => {
    const long: Msg[] = [call("t1", "read_file", { path: "app/big" }), { role: "tool", tool_call_id: "t1", content: "z".repeat(5000) }];
    expect(chatToMarkdown(chat(long), opts)).toContain("3,000 more characters not exported");
    expect(chatToMarkdown(chat(long), { ...opts, fullToolOutput: true })).not.toContain("not exported");
  });

  it("uses a fence that tool output containing backticks cannot close", () => {
    const md = chatToMarkdown(
      chat([call("t1", "read_file", { path: "a.md" }), { role: "tool", tool_call_id: "t1", content: "```js\ncode\n```" }]),
      opts,
    );
    expect(md).toContain("````\n```js\ncode\n```\n````");
  });

  it("shows a subagent's task and report instead of its tool calls", () => {
    const md = chatToMarkdown(
      chat([call("d1", "delegate_task", { project: "app", task: "t" })], {
        subagents: { d1: { project: "app", task: "Add tests", status: "done", report: "Added 3 tests", messages: [] } },
      }),
      opts,
    );
    expect(md).toContain("Subagent: app (done)");
    expect(md).toContain("**Task:** Add tests");
    expect(md).toContain("**Report:** Added 3 tests");
  });

  it("escapes markup in a tool label", () => {
    expect(chatToMarkdown(chat([call("t1", "run_command", { command: "echo <b>" })]), opts)).toContain("echo &lt;b>");
  });
});

describe("chatToJson", () => {
  it("is valid JSON with secrets removed and long results cut", () => {
    const json = chatToJson(
      chat([{ role: "user", content: KEY }, call("t1", "read_file", {}), { role: "tool", tool_call_id: "t1", content: "y".repeat(3000) }]),
      opts,
    );
    expect(json).not.toContain("0123456789abcdef");
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("Fix the bug");
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2].content).toContain("not exported");
  });
});

describe("exportFileName", () => {
  it("makes a safe name from the title", () => {
    expect(exportFileName("Fix the login bug!", "md")).toBe("fix-the-login-bug.md");
    expect(exportFileName("../../etc/passwd", "json")).toBe("etc-passwd.json");
    expect(exportFileName("日本語", "md")).toBe("chat.md");
  });
});
