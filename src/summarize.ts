import OpenAI from "openai";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { summaryRequest } from "./compaction";
import type { Todo } from "./todos";

export type Summary = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  cost?: number; // dollars, as OpenRouter reports it
};

const MAX_SUMMARY_TOKENS = 4000;

/** Asks the model to fold `slice` (and any earlier summary) into a new summary. Throws if it can't. */
export async function summarize(opts: {
  apiKey: string;
  model: string;
  previous: string;
  slice: Msg[];
  todos?: Todo[];
  signal?: AbortSignal;
  client?: Pick<OpenAI, "chat">; // for tests
}): Promise<Summary> {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, baseURL: "https://openrouter.ai/api/v1", dangerouslyAllowBrowser: true });
  const reply = await client.chat.completions.create(
    // `usage.include` asks OpenRouter to report what the request cost.
    { model: opts.model, messages: summaryRequest(opts.previous, opts.slice, opts.todos), max_tokens: MAX_SUMMARY_TOKENS, usage: { include: true } } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal: opts.signal },
  );
  const text = (reply.choices[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("The model returned an empty summary.");
  return {
    text,
    promptTokens: reply.usage?.prompt_tokens ?? 0,
    completionTokens: reply.usage?.completion_tokens ?? 0,
    cost: (reply.usage as { cost?: number } | undefined)?.cost,
  };
}
