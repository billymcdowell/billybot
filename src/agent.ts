import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { budgetText, stepLimitText } from "./history";
import { resolveLimits } from "./limits";
import { clipInstructions, formatInstructions, INSTRUCTIONS_FILE, type ProjectInstructions } from "./instructions";
import { checkPermission } from "./permissions";
import type { OpenProject, SubagentRun } from "./storage";
import { textOf } from "./text";
import { MAX_OPEN_PROJECTS } from "./tools/access";
import { getTool, toolsFor } from "./tools";
import { processResult, stagesFor, type ResultInfo } from "./tools/pipeline";
import type { AgentOptions } from "./tools/types";

export { toolsFor };
export type { AgentOptions };

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
// Model for subagents. Empty = same as the main agent. A cheaper model saves money.
export const SUBAGENT_MODEL = "";
const MAX_STEPS = 25; // per agent, so a confused model can't loop forever

export { textOf };

/**
 * Reads each project's CLAUDE.md, if it has one. It goes through the same locked read_file as
 * the agent's own reads, so a CLAUDE.md that is a symlink to somewhere else is refused.
 */
export async function loadInstructions(workspace: string, projects: OpenProject[]): Promise<ProjectInstructions[]> {
  const found = await Promise.all(
    projects.map(async (p) => {
      try {
        const text = clipInstructions(
          await invoke<string>("read_file", { workspace, project: p.name, path: INSTRUCTIONS_FILE }),
        );
        return text ? { project: p.name, text } : null;
      } catch {
        return null; // this project has no CLAUDE.md
      }
    }),
  );
  return found.filter((x): x is ProjectInstructions => x !== null);
}

export function systemPrompt(
  o: Pick<AgentOptions, "role" | "projects" | "workspace">,
  instructions: ProjectInstructions[] = [],
): string {
  const notes = formatInstructions(instructions);
  const withNotes = (prompt: string) => (notes ? `${prompt}\n\n${notes}` : prompt);
  const open = o.projects.length
    ? o.projects.map((p) => `${p.name} (${p.writable ? "writable" : "read-only"})`).join(", ")
    : "none";
  if (o.role === "sub") {
    const p = o.projects[0].name;
    return withNotes(
      `You are a subagent working only in the project "${p}". Every path starts with "${p}/". ` +
        "Complete the task, then reply with a short report: what you changed (list the files) and anything you could not do. " +
        "You cannot ask questions; if you are blocked, explain what you need in your report.",
    );
  }
  return withNotes([
    "You are a coding assistant. You work inside a workspace folder that holds one folder per project.",
    `Workspace: ${o.workspace}`,
    `Open projects: ${open}`,
    "Every file path starts with a project name, e.g. \"my-app/src/index.ts\".",
    "To change an existing file, read it and use edit_file for the part that changes (multi_edit for several changes to one file); use write_file for new files or complete rewrites.",
    "To find things, use grep (file contents) and glob (file names) rather than reading files one by one. Long files are read in parts: use read_file's offset to continue.",
    "Use run_command for things only a shell can do, such as running tests or a build. The user approves every command, so don't run commands you don't need, and never run anything destructive or that reaches outside the project unless the user asked for it.",
    "When a task starts, call list_projects to find the right project and open it. Create a project only if nothing fits.",
    `Open projects read-only unless you need to change them. At most ${MAX_OPEN_PROJECTS} can be open; close ones you no longer need.`,
    "For larger jobs spanning projects, use delegate_task to give each project its own subagent, and include any shared contract in each task.",
    "Be concise.",
  ].join("\n"));
}

// ---------- Running one tool call ----------

async function execute(
  call: { id: string; name: string; args: string },
  o: AgentOptions,
  delegateSlot: number,
): Promise<string> {
  // After Stop, the rest of this turn's tool calls must not start (they still need a result,
  // or the API rejects the conversation).
  if (o.signal?.aborted) return "Cancelled: the user pressed Stop.";
  const who = o.who ?? "Main agent";
  let status: ResultInfo["status"] = "ok";
  let text: string;
  try {
    const args = JSON.parse(call.args || "{}");
    const tool = getTool(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    if (!tool.roles.includes(o.role ?? "main")) {
      throw new Error(tool.subagentRefusal ?? `Subagents cannot use ${tool.name}.`);
    }

    // Permission: per project for file tools and commands, per workspace for create_project.
    const target = tool.target?.(args, o) ?? null;
    const where = target?.project ?? "workspace";
    const scope = target ? `${o.workspace}/${target.project}` : o.workspace;
    const before = await tool.preview?.(args, target, o);
    const refusal = await checkPermission(
      { tool: tool.name, category: tool.category, args, who, where, before },
      o.getMode(),
      scope,
      o.ask,
    );
    if (refusal) {
      status = "refused";
      text = refusal;
    } else {
      text = await tool.run(args, target, { o, callId: call.id, delegateSlot, runSubagent: (id, p, t) => runSubagent(id, p, t, o) });
    }
  } catch (e) {
    status = "error";
    text = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return processResult(text, { tool: call.name, who, status }, stagesFor(resolveLimits(o.limits)));
}

// ---------- Subagents ----------

async function runSubagent(callId: string, project: string, task: string, o: AgentOptions) {
  if (o.role === "sub") throw new Error("Subagents cannot delegate.");
  await invoke("check_project", { workspace: o.workspace, name: project });

  const run: SubagentRun = { project, task, status: "running", messages: [{ role: "user", content: task }] };
  const report = () => o.onSubagent?.(callId, { ...run, messages: [...run.messages] });
  report();

  try {
    run.messages = await runAgent({
      ...o, // same key, workspace, mode, approvals and Stop signal
      model: SUBAGENT_MODEL || o.model,
      role: "sub",
      who: `${project} agent`,
      projects: [{ name: project, writable: true }],
      onProjectsChange: undefined,
      onSubagent: undefined,
      messages: run.messages,
      onUpdate: (msgs) => {
        run.messages = msgs;
        report();
      },
    });
    run.report = textOf(run.messages[run.messages.length - 1]?.content) || "(no report)";
    run.status = o.signal?.aborted ? "stopped" : "done"; // Stop makes the loop return rather than throw
  } catch (e) {
    run.status = o.signal?.aborted ? "stopped" : "failed";
    run.report = `Subagent ${run.status}: ${e instanceof Error ? e.message : String(e)}`;
  }
  report();
  return `Report from the ${project} agent:\n${run.report}`;
}

// ---------- The agent loop ----------

export async function runAgent(o: AgentOptions): Promise<ChatCompletionMessageParam[]> {
  const client = new OpenAI({
    apiKey: o.apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    dangerouslyAllowBrowser: true, // fine here: this is your own desktop app
  });
  const tools = toolsFor(o.role);
  const messages = [...o.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    // Stop before spending more if the chat has hit its cap.
    const cap = o.overBudget?.();
    if (cap) {
      messages.push({ role: "assistant", content: budgetText(cap) });
      o.onUpdate(messages, "");
      return messages;
    }
    // Anything you typed while the agent was working joins the conversation here, between steps.
    const steering = o.role === "sub" || step === 0 ? [] : (o.takeSteering?.() ?? []);
    for (const text of steering) messages.push({ role: "user", content: text });
    if (steering.length) o.onUpdate(messages, "");

    // 1. Send the conversation (with a fresh system prompt) and stream the reply.
    // The projects (and so their CLAUDE.md files) can change between steps, so read them each time.
    const instructions = await loadInstructions(o.workspace, o.projects);
    const system: ChatCompletionMessageParam = { role: "system", content: systemPrompt(o, instructions) };
    let text = "";
    const calls: { id: string; name: string; args: string }[] = [];
    try {
      const stream = await client.chat.completions.create(
        // `usage.include` asks OpenRouter to report what the request cost.
        { model: o.model, messages: [system, ...messages], tools, stream: true, usage: { include: true } } as ChatCompletionCreateParamsStreaming,
        { signal: o.signal },
      );
      for await (const chunk of stream) {
        // OpenRouter reports token usage on the last chunk of a streamed reply.
        if (chunk.usage) {
          o.onUsage?.({
            model: o.model,
            role: o.role ?? "main",
            who: o.who ?? "Main agent",
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            cost: (chunk.usage as { cost?: number }).cost,
          });
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          o.onUpdate(messages, text);
        }
        for (const tc of delta.tool_calls ?? []) {
          const call = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name = tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
      }
    } catch (e) {
      if (!o.signal?.aborted) throw e;
      // The user pressed Stop. Keep what the model had said so far; a half-streamed tool call
      // is dropped, since its arguments are incomplete and nothing ran.
      if (text) messages.push({ role: "assistant", content: text });
      o.onUpdate(messages, "");
      return messages;
    }
    const toolCalls = calls.filter(Boolean);

    // 2. Save what the model said.
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: text });
      o.onUpdate(messages, "");
      return messages;
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

    // 3. Run the tools. Ordinary tools run one after another, in order;
    //    delegate_task calls start immediately and run side by side.
    const addResult = (id: string, content: string) => {
      messages.push({ role: "tool", tool_call_id: id, content });
      o.onUpdate(messages, "");
    };
    const subagents: Promise<void>[] = [];
    let slot = 0;
    for (const call of toolCalls) {
      if (call.name === "delegate_task") {
        subagents.push(execute(call, o, slot++).then((r) => addResult(call.id, r)));
      } else {
        addResult(call.id, await execute(call, o, 0));
      }
    }
    await Promise.all(subagents);
    // 4. Loop: send the results back so the model can continue.
  }

  messages.push({ role: "assistant", content: stepLimitText(MAX_STEPS) });
  return messages;
}
