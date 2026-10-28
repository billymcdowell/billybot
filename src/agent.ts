import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { summarizeArgs, type ActivityDraft } from "./activity";
import { budgetText, stepLimitText } from "./history";
import { resolveLimits } from "./limits";
import { clipInstructions, formatInstructions, INSTRUCTIONS_FILE, type ProjectInstructions } from "./instructions";
import { checkPermission, type Approval, type AskFn } from "./permissions";
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
  o: Pick<AgentOptions, "role" | "projects" | "workspace"> & { getMode?: AgentOptions["getMode"] },
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
    ...(o.getMode?.() === "plan"
      ? [
          "PLAN MODE is on. You cannot change anything: edits and commands are refused. Explore with the read-only tools (list_projects, list_dir, read_file, grep, glob), then reply with a concrete plan: the files you would change and how, the order of the steps, risks, and how to check it worked. Do not try to make the changes. The user will review the plan and approve it before you can act.",
        ]
      : []),
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
  const depth = o.role === "sub" ? 1 : 0;
  const emit = (d: ActivityDraft) => o.onEvent?.({ who, depth, ...d });
  const started = performance.now();
  let status: ResultInfo["status"] = "ok";
  // an object, because the approval callback below changes it and TypeScript can't see that
  const verdict = { decision: "auto" as "auto" | "approved" | "always" | "denied" | "refused" };
  let text: string;
  let args: unknown = {};
  let kind: "tool" | "command" = "tool";
  let danger: string | undefined;
  try {
    args = JSON.parse(call.args || "{}");
    const tool = getTool(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    if (!tool.roles.includes(o.role ?? "main")) {
      throw new Error(tool.subagentRefusal ?? `Subagents cannot use ${tool.name}.`);
    }
    kind = tool.category === "command" ? "command" : "tool";
    emit({ category: kind, ref: call.id, pending: true, summary: `${call.name} ${summarizeArgs(args)}`.trim() });

    // Permission: per project for file tools and commands, per workspace for create_project.
    const target = tool.target?.(args as Record<string, unknown>, o) ?? null;
    const where = target?.project ?? "workspace";
    const scope = target ? `${o.workspace}/${target.project}` : o.workspace;
    const before = await tool.preview?.(args as Record<string, unknown>, target, o);
    const risk = tool.risk?.(args as Record<string, unknown>) ?? {};
    danger = risk.danger;
    const mode = o.getMode();
    // Asking is where the log shows you were waited on, and what you said.
    const ask: AskFn = async (req) => {
      const approval = `approval-${call.id}`;
      emit({
        category: "approval", ref: approval, pending: true, level: req.danger ? "warn" : "info",
        summary: `Waiting for your approval: ${call.name}`,
        detail: { tool: call.name, where, mode, ...(req.danger ? { danger: req.danger } : {}), ...(req.warning ? { warning: req.warning } : {}) },
      });
      const waitStart = performance.now();
      const answer: Approval = await o.ask(req);
      verdict.decision = answer === "deny" ? "denied" : answer === "always" ? "always" : "approved";
      emit({
        category: "approval", ref: approval, level: answer === "deny" ? "warn" : "info",
        summary: `${answer === "deny" ? "You denied" : answer === "always" ? "You approved, and always allowed" : "You approved"}: ${call.name}`,
        detail: { tool: call.name, where, mode, waitedMs: Math.round(performance.now() - waitStart) },
      });
      return answer;
    };
    const refusal = await checkPermission(
      { tool: tool.name, category: tool.category, args: args as Record<string, unknown>, who, where, before, mode, ...risk },
      mode,
      scope,
      ask,
    );
    if (refusal) {
      status = "refused";
      if (verdict.decision === "auto") verdict.decision = "refused";
      text = refusal;
    } else {
      text = await tool.run(args as Record<string, unknown>, target, { o, callId: call.id, delegateSlot, runSubagent: (id, p, t) => runSubagent(id, p, t, o) });
    }
  } catch (e) {
    status = "error";
    text = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const info: ResultInfo = { tool: call.name, who, status, notes: [] };
  const result = await processResult(text, info, stagesFor({ ...resolveLimits(o.limits), redact: o.redact }));

  // What happened, for the activity log.
  const exit = kind === "command" && status === "ok" ? /^Exit code (\d+)/.exec(text) : null;
  const ended = status === "ok" && kind === "command" && /^(Timed out|Cancelled)/.test(text);
  const outcome =
    status === "error" ? text.replace(/^Error: /, "").slice(0, 100)
    : status === "refused" ? (verdict.decision === "denied" ? "you denied it" : "refused")
    : exit ? `exit ${exit[1]}`
    : ended ? text.split(/[.\n]/)[0].toLowerCase()
    : `ok, ${text.length.toLocaleString("en-US")} chars`;
  emit({
    category: kind, ref: call.id,
    level: status === "error" ? "error" : status === "refused" || ended || (exit && exit[1] !== "0") ? "warn" : "info",
    summary: `${call.name} ${summarizeArgs(args)} → ${outcome}`.replace(/\s+/g, " "),
    durationMs: Math.round(performance.now() - started),
    detail: {
      arguments: summarizeArgs(args, 600), decision: verdict.decision, status, resultChars: text.length, sentToModelChars: result.length,
      ...(info.notes?.length ? { changes: info.notes } : {}), ...(danger ? { flagged: danger } : {}),
      ...(exit ? { exitCode: Number(exit[1]) } : {}), preview: result.slice(0, 400),
    },
  });
  return result;
}

// ---------- Subagents ----------

async function runSubagent(callId: string, project: string, task: string, o: AgentOptions) {
  if (o.role === "sub") throw new Error("Subagents cannot delegate.");
  await invoke("check_project", { workspace: o.workspace, name: project });

  const run: SubagentRun = { project, task, status: "running", messages: [{ role: "user", content: task }] };
  const report = () => o.onSubagent?.(callId, { ...run, messages: [...run.messages] });
  report();
  const began = performance.now();
  const ref = `subagent-${callId}`;
  o.onEvent?.({ category: "subagent", ref, pending: true, who: o.who ?? "Main agent", summary: `Subagent for ${project}: ${task.replace(/\s+/g, " ").slice(0, 80)}`, detail: { project, taskChars: task.length } });

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
  o.onEvent?.({
    category: "subagent", ref, who: o.who ?? "Main agent",
    level: run.status === "done" ? "info" : "warn",
    summary: `Subagent for ${project} ${run.status}`,
    durationMs: Math.round(performance.now() - began),
    detail: { project, status: run.status, steps: run.messages.filter((m) => m.role === "assistant").length, report: (run.report ?? "").slice(0, 400) },
  });
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
  const who = o.who ?? "Main agent";
  const depth = o.role === "sub" ? 1 : 0;
  const emit = (d: ActivityDraft) => o.onEvent?.({ who, depth, ...d });
  const runKey = Math.random().toString(36).slice(2, 8); // makes each request's log row unique

  for (let step = 0; step < MAX_STEPS; step++) {
    // Stop before spending more if the chat has hit its cap.
    const cap = o.overBudget?.();
    if (cap) {
      messages.push({ role: "assistant", content: budgetText(cap) });
      o.onUpdate(messages, "");
      emit({ category: "chat", level: "warn", summary: `Stopped before the next request: the chat reached its $${cap.toFixed(2)} budget` });
      return messages;
    }
    // Anything you typed while the agent was working joins the conversation here, between steps.
    const steering = o.role === "sub" || step === 0 ? [] : (o.takeSteering?.() ?? []);
    for (const text of steering) messages.push({ role: "user", content: text });
    if (steering.length) {
      o.onUpdate(messages, "");
      emit({ category: "chat", summary: `${steering.length === 1 ? "A message you queued" : `${steering.length} messages you queued`} joined the run`, detail: { text: steering.join("\n").slice(0, 300) } });
    }

    // 1. Send the conversation (with a fresh system prompt) and stream the reply.
    // The projects (and so their CLAUDE.md files) can change between steps, so read them each time.
    const instructions = await loadInstructions(o.workspace, o.projects);
    const system: ChatCompletionMessageParam = { role: "system", content: systemPrompt(o, instructions) }; // o.getMode() is read each step, so changing mode takes effect at once
    let text = "";
    const calls: { id: string; name: string; args: string }[] = [];
    const requestRef = `request-${runKey}-${step}`;
    const sentAt = performance.now();
    let firstTokenMs: number | undefined;
    let usage: { input: number; output: number; cost?: number } | undefined;
    emit({
      category: "request", ref: requestRef, pending: true,
      summary: `Asking ${o.model} (step ${step + 1})`,
      detail: { model: o.model, step: step + 1, messagesSent: messages.length + 1, toolsOffered: tools.length },
    });
    try {
      const stream = await client.chat.completions.create(
        // `usage.include` asks OpenRouter to report what the request cost.
        { model: o.model, messages: [system, ...messages], tools, stream: true, usage: { include: true } } as ChatCompletionCreateParamsStreaming,
        { signal: o.signal },
      );
      for await (const chunk of stream) {
        // OpenRouter reports token usage on the last chunk of a streamed reply.
        if (chunk.usage) {
          usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, cost: (chunk.usage as { cost?: number }).cost };
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
        if (firstTokenMs === undefined && (delta.content || delta.tool_calls)) firstTokenMs = Math.round(performance.now() - sentAt);
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
      if (!o.signal?.aborted) {
        emit({ category: "request", ref: requestRef, level: "error", summary: `Request to ${o.model} failed: ${e instanceof Error ? e.message : String(e)}`, durationMs: Math.round(performance.now() - sentAt) });
        throw e;
      }
      emit({ category: "request", ref: requestRef, level: "warn", summary: `Request to ${o.model} cancelled`, durationMs: Math.round(performance.now() - sentAt), detail: { charsReceived: text.length } });
      // The user pressed Stop. Keep what the model had said so far; a half-streamed tool call
      // is dropped, since its arguments are incomplete and nothing ran.
      if (text) messages.push({ role: "assistant", content: text });
      o.onUpdate(messages, "");
      return messages;
    }
    const toolCalls = calls.filter(Boolean);
    emit({
      category: "request", ref: requestRef,
      summary: `${o.model} replied: ${toolCalls.length ? `${toolCalls.length} tool ${toolCalls.length === 1 ? "call" : "calls"} (${toolCalls.map((c) => c.name).join(", ")})` : `${text.length.toLocaleString("en-US")} characters of text`}`,
      durationMs: Math.round(performance.now() - sentAt),
      detail: {
        model: o.model, step: step + 1, firstTokenMs, textChars: text.length, toolCalls: toolCalls.map((c) => c.name),
        ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}) } : {}),
      },
    });

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

  emit({ category: "chat", level: "warn", summary: `Stopped after ${MAX_STEPS} steps (the limit for one run)` });
  messages.push({ role: "assistant", content: stepLimitText(MAX_STEPS) });
  return messages;
}
