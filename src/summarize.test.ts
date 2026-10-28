import { describe, expect, it, vi } from "vitest";
import { summarize } from "./summarize";

const client = (reply: object) => {
  const create = vi.fn(async (_p: unknown, _o?: unknown) => reply);
  return { create, client: { chat: { completions: { create } } } as never };
};

describe("summarize", () => {
  it("sends the transcript to the model and returns its summary with what it cost", async () => {
    const { create, client: c } = client({ choices: [{ message: { content: "  They fixed the bug.  " } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.004 } });
    const out = await summarize({
      apiKey: "k", model: "m", previous: "Earlier work.", client: c,
      slice: [{ role: "user", content: "fix it" }, { role: "assistant", content: "done" }],
      todos: [{ content: "Test it", status: "pending" }],
    });
    expect(out).toEqual({ text: "They fixed the bug.", promptTokens: 900, completionTokens: 60, cost: 0.004 });
    const sent = create.mock.calls[0][0] as { model: string; messages: { content: string }[]; usage: unknown; max_tokens: number };
    expect(sent).toMatchObject({ model: "m", usage: { include: true }, max_tokens: 4000 });
    expect(sent.messages[1].content).toContain("Earlier work.");
    expect(sent.messages[1].content).toContain("[pending] Test it");
    expect(sent.messages[1].content).toContain("[User]\nfix it");
  });

  it("passes the stop signal on", async () => {
    const { create, client: c } = client({ choices: [{ message: { content: "s" } }] });
    const controller = new AbortController();
    await summarize({ apiKey: "k", model: "m", previous: "", slice: [], signal: controller.signal, client: c });
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it("works when the reply has no usage information", async () => {
    const { client: c } = client({ choices: [{ message: { content: "s" } }] });
    expect(await summarize({ apiKey: "k", model: "m", previous: "", slice: [], client: c })).toEqual({ text: "s", promptTokens: 0, completionTokens: 0, cost: undefined });
  });

  it("refuses an empty summary and lets API errors through", async () => {
    await expect(summarize({ apiKey: "k", model: "m", previous: "", slice: [], client: client({ choices: [{ message: { content: "  " } }] }).client })).rejects.toThrow("empty summary");
    await expect(summarize({ apiKey: "k", model: "m", previous: "", slice: [], client: client({ choices: [] }).client })).rejects.toThrow("empty summary");
    const failing = { chat: { completions: { create: async () => { throw new Error("402 out of credits"); } } } } as never;
    await expect(summarize({ apiKey: "k", model: "m", previous: "", slice: [], client: failing })).rejects.toThrow("402 out of credits");
  });
});
