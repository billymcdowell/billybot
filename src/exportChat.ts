import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { formatCost } from "./cost";
import { redactDeep, redactText } from "./redact";
import type { Conversation } from "./storage";
import { textOf } from "./text";

export type ExportOptions = {
  fullToolOutput: boolean; // otherwise each tool result is cut to a few thousand characters
  date?: Date;
};

const SHORT = 2000;

function shorten(text: string, full: boolean) {
  if (full || text.length <= SHORT) return text;
  return `${text.slice(0, SHORT)}\n[… ${(text.length - SHORT).toLocaleString("en-US")} more characters not exported …]`;
}

/** A code fence longer than any run of backticks inside the text, so the text can't close it early. */
function fenced(text: string, lang = "") {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

type Call = { id: string; name: string; args: string };
const callsOf = (m: Msg): Call[] =>
  m.role === "assistant" && m.tool_calls
    ? m.tool_calls.flatMap((c) => (c.type === "function" ? [{ id: c.id, name: c.function.name, args: c.function.arguments }] : []))
    : [];

function describeCall(c: Call): string {
  try {
    const a = JSON.parse(c.args || "{}");
    const target = a.path ?? a.command ?? a.name ?? (a.pattern ? `${a.pattern}` : "");
    return `${c.name} ${String(target)}`.trim();
  } catch {
    return c.name;
  }
}

/** The whole chat as a Markdown document. Secrets are redacted. */
export function chatToMarkdown(c: Conversation, o: ExportOptions): string {
  const results = new Map<string, string>();
  for (const m of c.messages) if (m.role === "tool") results.set(m.tool_call_id, textOf(m.content));

  const out: string[] = [`# ${c.title}`];
  const facts = [
    `Exported ${(o.date ?? new Date()).toISOString().slice(0, 10)}`,
    c.projects.length ? `Projects: ${c.projects.map((p) => `${p.name} (${p.writable ? "writable" : "read-only"})`).join(", ")}` : "",
    c.usage && c.usage.requests > 0 ? `Cost: ${formatCost(c.usage.cost)}${c.usage.unpriced > 0 ? "+" : ""}` : "",
  ].filter(Boolean);
  out.push(`*${facts.join(" · ")}*`);

  c.messages.forEach((m, index) => {
    if (c.compaction && index === c.compaction.upTo && c.compaction.summary.trim()) {
      out.push(
        `<details>\n<summary>From here on, the model saw a summary of the messages above instead of the messages themselves.</summary>\n\n${redactText(c.compaction.summary)}\n\n</details>`,
      );
    }
    if (m.role === "user") {
      out.push(`## You\n\n${redactText(textOf(m.content))}`);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      if (textOf(m.content)) parts.push(redactText(textOf(m.content)));
      for (const call of callsOf(m)) {
        const sub = c.subagents[call.id];
        const body = sub
          ? [`**Task:** ${redactText(sub.task)}`, sub.report ? `**Report:** ${redactText(sub.report)}` : ""].filter(Boolean).join("\n\n")
          : [
              fenced(shorten(redactText(call.args), o.fullToolOutput), "json"),
              results.has(call.id) ? fenced(shorten(redactText(results.get(call.id)!), o.fullToolOutput)) : "",
            ].filter(Boolean).join("\n\n");
        const label = sub ? `Subagent: ${sub.project} (${sub.status})` : describeCall(call);
        parts.push(`<details>\n<summary>${redactText(label).replace(/</g, "&lt;")}</summary>\n\n${body}\n\n</details>`);
      }
      if (parts.length) out.push(`## Assistant\n\n${parts.join("\n\n")}`);
    }
  });
  return out.join("\n\n") + "\n";
}

/** The whole chat as JSON, redacted. */
export function chatToJson(c: Conversation, o: ExportOptions): string {
  const messages = c.messages.map((m) =>
    m.role === "tool" && typeof m.content === "string" ? { ...m, content: shorten(m.content, o.fullToolOutput) } : m,
  );
  const subagents = Object.fromEntries(
    Object.entries(c.subagents).map(([id, run]) => [
      id,
      { ...run, messages: run.messages.map((m) => (m.role === "tool" && typeof m.content === "string" ? { ...m, content: shorten(m.content, o.fullToolOutput) } : m)) },
    ]),
  );
  const { title, id, updatedAt, projects, usage, compaction } = c;
  return JSON.stringify(redactDeep({ title, id, updatedAt, projects, usage, compaction, messages, subagents }), null, 2) + "\n";
}

/** A file name from the chat's title: letters, digits, spaces turned to dashes. */
export function exportFileName(title: string, ext: "md" | "json"): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return `${base || "chat"}.${ext}`;
}
