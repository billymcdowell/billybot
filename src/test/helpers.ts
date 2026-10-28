import { vi } from "vitest";
import type { ApprovalRequest } from "../permissions";

type Delta = { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };

/** One streamed model reply, as the chunks the OpenAI SDK would yield. */
export type Reply = { text?: string; calls?: { id: string; name: string; args: object }[]; usage?: { prompt: number; completion: number; cost?: number } };

export const say = (text: string): Reply => ({ text });
export const call = (name: string, args: object = {}, id = `call_${name}`) => ({ id, name, args });
export const useTools = (...calls: { id: string; name: string; args: object }[]): Reply => ({ calls });

async function* chunks(reply: Reply) {
  if (reply.text) yield { choices: [{ delta: { content: reply.text } satisfies Delta }] };
  for (const [index, c] of (reply.calls ?? []).entries()) {
    yield {
      choices: [
        { delta: { tool_calls: [{ index, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } satisfies Delta },
      ],
    };
  }
  if (reply.usage) {
    yield { choices: [], usage: { prompt_tokens: reply.usage.prompt, completion_tokens: reply.usage.completion, cost: reply.usage.cost } };
  }
}

/**
 * A stand-in for the OpenAI client. Main-agent requests take the next reply from `script`;
 * requests whose system prompt marks a subagent are answered by `subagent` instead, because
 * subagents run side by side and could not share an ordered script.
 */
export function fakeClient(script: Reply[], subagent: (task: string) => Reply = () => say("subagent done")) {
  const requests: { model: string; messages: { role: string; content?: unknown }[]; tools: { function: { name: string } }[] }[] = [];
  const create = vi.fn(async (params: (typeof requests)[number]) => {
    requests.push(params);
    const system = String(params.messages[0]?.content ?? "");
    if (system.includes("You are a subagent")) {
      const task = String(params.messages.find((m) => m.role === "user")?.content ?? "");
      return chunks(subagent(task));
    }
    const next = script.shift();
    if (!next) throw new Error("fakeClient: the script ran out of replies");
    return chunks(next);
  });
  return { create, requests };
}

/** An `ask` function that records what it was asked and answers with `answer`. */
export function recordingAsk(answer: "once" | "always" | "deny" = "once") {
  const asked: ApprovalRequest[] = [];
  const ask = vi.fn(async (req: ApprovalRequest) => {
    asked.push(req);
    return answer;
  });
  return { ask, asked };
}
