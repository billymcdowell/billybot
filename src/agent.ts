import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { checkPermission, type AskFn } from "./permissions";
import type { Mode } from "./storage";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const MAX_STEPS = 25; // safety stop so a confused model can't loop forever

// ---------- Tool definitions the model sees ----------

const pathParam = {
  type: "string",
  description: "Path relative to the project folder. Use . for the folder itself.",
};

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders at a path. Folder names end with /.",
      parameters: { type: "object", properties: { path: pathParam }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file and return its contents.",
      parameters: { type: "object", properties: { path: pathParam }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file with the full new contents. Read the file first when changing it.",
      parameters: {
        type: "object",
        properties: { path: pathParam, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
];

// ---------- Running a tool = calling the Rust command ----------

async function runTool(name: string, args: Record<string, unknown>, folder: string) {
  switch (name) {
    case "list_dir": {
      const names = await invoke<string[]>("list_dir", { root: folder, path: args.path });
      return names.join("\n") || "(empty folder)";
    }
    case "read_file":
      return invoke<string>("read_file", { root: folder, path: args.path });
    case "write_file":
      return invoke<string>("write_file", {
        root: folder,
        path: args.path,
        content: args.content,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- The agent loop ----------

export type AgentOptions = {
  apiKey: string;
  model: string;
  folder: string;
  getMode: () => Mode; // read fresh each call, so switching modes mid-run works
  messages: ChatCompletionMessageParam[]; // history, ending with the new user message
  ask: AskFn; // shows the approval prompt
  onUpdate: (messages: ChatCompletionMessageParam[], streamingText: string) => void;
  signal?: AbortSignal; // lets the Stop button cancel
};

export async function runAgent(o: AgentOptions): Promise<ChatCompletionMessageParam[]> {
  const client = new OpenAI({
    apiKey: o.apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    dangerouslyAllowBrowser: true, // fine here: this is your own desktop app
  });

  const system: ChatCompletionMessageParam = {
    role: "system",
    content:
      `You are a coding assistant working in the folder ${o.folder}. ` +
      "Use the tools to look at files before changing them. All paths are relative to that folder. " +
      "Be concise.",
  };

  const messages = [...o.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    // 1. Send the conversation and stream the reply.
    const stream = await client.chat.completions.create(
      { model: o.model, messages: [system, ...messages], tools: TOOLS, stream: true },
      { signal: o.signal },
    );

    let text = "";
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        o.onUpdate(messages, text);
      }
      // Tool calls arrive in pieces; glue them back together by index.
      for (const tc of delta.tool_calls ?? []) {
        const call = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
    }

    const toolCalls = calls.filter(Boolean);

    // 2. Save what the model said.
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: text });
      o.onUpdate(messages, "");
      return messages; // plain answer, no tools: we're done
    }
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    });
    o.onUpdate(messages, "");

    // 3. Run each tool (if allowed) and add its result.
    for (const call of toolCalls) {
      let result: string;
      try {
        const args = JSON.parse(call.args || "{}");
        const refusal = await checkPermission(call.name, args, o.getMode(), o.folder, o.ask);
        result = refusal ?? (await runTool(call.name, args, o.folder));
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      o.onUpdate(messages, "");
    }
    // 4. Loop: send the results back so the model can continue.
  }

  messages.push({ role: "assistant", content: `Stopped after ${MAX_STEPS} steps.` });
  return messages;
}
