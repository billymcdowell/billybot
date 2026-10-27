import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// There's no tokenizer in the app, so sizes are estimates: English text and code average
// roughly 4 characters per token. The exact figure for the last request comes from the API.
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4; // role markers and formatting around each message

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export type ContextPart = {
  id: "messages" | "results" | "system" | "instructions" | "tools" | "free";
  label: string;
  tokens: number;
};

export type ContextBreakdown = {
  parts: ContextPart[]; // everything except free space
  used: number; // estimated tokens in use
  window: number | null; // the model's context size, if known
  free: number | null;
};

/** Message content can be a string or a list of text parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === "text" ? p.text : "")).join("");
  return "";
}

type Input = {
  systemText: string; // the system prompt
  toolsText: string; // the tool definitions, as JSON
  instructionsText?: string; // the open projects' CLAUDE.md notes, as added to the prompt
  messages: ChatCompletionMessageParam[];
  streaming?: string; // reply text still arriving
  window: number | null; // the model's context size, if known
};

/** Splits the conversation into what the model reads on every request. */
export function contextBreakdown(input: Input): ContextBreakdown {
  let messages = input.streaming ? estimateTokens(input.streaming) + PER_MESSAGE_OVERHEAD : 0;
  let results = 0;
  for (const m of input.messages) {
    if (m.role === "tool") {
      results += estimateTokens(contentText(m.content)) + PER_MESSAGE_OVERHEAD;
    } else if (m.role === "assistant") {
      // The model's words plus the tool calls it made (their names and arguments).
      const calls = (m.tool_calls ?? []).map((c) => (c.type === "function" ? c.function.name + c.function.arguments : ""));
      messages += estimateTokens(contentText(m.content) + calls.join("")) + PER_MESSAGE_OVERHEAD;
    } else {
      messages += estimateTokens(contentText(m.content)) + PER_MESSAGE_OVERHEAD;
    }
  }

  const parts: ContextPart[] = [
    { id: "messages", label: "Messages", tokens: messages },
    { id: "results", label: "Tool results", tokens: results },
    { id: "system", label: "System prompt", tokens: estimateTokens(input.systemText) },
    ...(input.instructionsText
      ? [{ id: "instructions" as const, label: "Project instructions", tokens: estimateTokens(input.instructionsText) }]
      : []),
    { id: "tools", label: "Tool definitions", tokens: estimateTokens(input.toolsText) },
  ];
  const used = parts.reduce((sum, p) => sum + p.tokens, 0);
  return {
    parts,
    used,
    window: input.window,
    free: input.window === null ? null : Math.max(0, input.window - used),
  };
}

/** 321500 → "321.5k", 1000000 → "1M", 850 → "850" */
export function formatTokens(n: number): string {
  const trim = (x: number) => String(Number(x.toFixed(1)));
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}
