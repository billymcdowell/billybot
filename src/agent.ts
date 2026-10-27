import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { checkPermission, type AskFn } from "./permissions";
import type { Mode, OpenProject, SubagentRun } from "./storage";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
// Model for subagents. Empty = same as the main agent. A cheaper model saves money.
export const SUBAGENT_MODEL = "";
const MAX_STEPS = 25; // per agent, so a confused model can't loop forever
const MAX_OPEN_PROJECTS = 3;
const MAX_SUBAGENTS_PER_TURN = 3;

/** Message content can be a string or a list of parts; this returns the text. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === "text" ? p.text : "")).join("");
  }
  return "";
}

// ---------- Tool definitions the model sees ----------

const fn = (name: string, description: string, properties: object, required: string[]) =>
  ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  }) as ChatCompletionTool;

const path = {
  type: "string",
  description: 'Starts with an open project\'s name, e.g. "my-app/src/index.ts". Use "my-app" for its root.',
};

const FILE_TOOLS = [
  fn("list_dir", "List files and folders. Folder names end with /.", { path }, ["path"]),
  fn("read_file", "Read a text file.", { path }, ["path"]),
  fn(
    "write_file",
    "Create a new text file, or replace a file completely, with its full new contents. For a small change to an existing file, use edit_file instead. The project must be open as writable.",
    { path, content: { type: "string" } },
    ["path", "content"],
  ),
  fn(
    "edit_file",
    "Change part of an existing file by replacing one exact snippet. Read the file first and copy old_text exactly, including spaces and line breaks. It must match exactly once, so include enough surrounding lines to be unique. The project must be open as writable.",
    {
      path,
      old_text: { type: "string", description: "The exact text to replace." },
      new_text: { type: "string", description: "What to put in its place." },
    },
    ["path", "old_text", "new_text"],
  ),
];

// Tools that change a file, so the project must be open as writable.
const WRITING_FILE_TOOLS = ["write_file", "edit_file"];

const PROJECT_TOOLS = [
  fn("list_projects", "List the projects in the workspace with their README summary.", {}, []),
  fn(
    "open_project",
    "Open an existing project. Read-only by default; pass writable: true only if you need to change it. Opening again changes its access.",
    { name: { type: "string" }, writable: { type: "boolean" } },
    ["name"],
  ),
  fn("close_project", "Close a project you no longer need.", { name: { type: "string" } }, ["name"]),
  fn(
    "create_project",
    "Create a new, empty project folder and open it as writable. Only when no existing project fits. Names: letters, numbers, - and _.",
    { name: { type: "string" } },
    ["name"],
  ),
  fn(
    "delegate_task",
    "Hand a self-contained task in one project to a subagent. It gets write access to that project only, works on its own, and returns a report. Calls made in the same turn run in parallel.",
    {
      project: { type: "string" },
      task: {
        type: "string",
        description: "Everything the subagent needs: the goal, constraints, and any shared contract such as data shapes or URLs. It cannot ask you questions.",
      },
    },
    ["project", "task"],
  ),
];

// Only the main agent gets this, not subagents.
const SHELL_TOOLS = [
  fn(
    "run_command",
    "Run a shell command (tests, a build, installing packages, git) in the folder of an open, writable project. The user must approve every command, so keep each one short and purposeful. It cannot ask questions or take input, and it is stopped after the time limit. Do not use it to read or write files: use the file tools for that.",
    {
      project: { type: "string", description: "The open, writable project to run the command in." },
      command: { type: "string" },
      timeout_seconds: { type: "number", description: "Optional time limit. Default 60, at most 300." },
    },
    ["project", "command"],
  ),
];

// ---------- Options ----------

export type AgentOptions = {
  apiKey: string;
  model: string;
  workspace: string;
  projects: OpenProject[]; // this agent's open projects; its tools change this list
  onProjectsChange?: (projects: OpenProject[]) => void;
  getMode: () => Mode;
  messages: ChatCompletionMessageParam[]; // history, ending with the new user message
  ask: AskFn;
  onUpdate: (messages: ChatCompletionMessageParam[], streamingText: string) => void;
  onSubagent?: (callId: string, run: SubagentRun) => void; // progress of subagents
  signal?: AbortSignal;
  role?: "main" | "sub";
  who?: string; // shown on approval cards
};

function systemPrompt(o: AgentOptions): string {
  const open = o.projects.length
    ? o.projects.map((p) => `${p.name} (${p.writable ? "writable" : "read-only"})`).join(", ")
    : "none";
  if (o.role === "sub") {
    const p = o.projects[0].name;
    return (
      `You are a subagent working only in the project "${p}". Every path starts with "${p}/". ` +
      "Complete the task, then reply with a short report: what you changed (list the files) and anything you could not do. " +
      "You cannot ask questions; if you are blocked, explain what you need in your report."
    );
  }
  return [
    "You are a coding assistant. You work inside a workspace folder that holds one folder per project.",
    `Workspace: ${o.workspace}`,
    `Open projects: ${open}`,
    "Every file path starts with a project name, e.g. \"my-app/src/index.ts\".",
    "To change an existing file, read it and use edit_file for the part that changes; use write_file for new files or complete rewrites.",
    "Use run_command for things only a shell can do, such as running tests or a build. The user approves every command, so don't run commands you don't need, and never run anything destructive or that reaches outside the project unless the user asked for it.",
    "When a task starts, call list_projects to find the right project and open it. Create a project only if nothing fits.",
    `Open projects read-only unless you need to change them. At most ${MAX_OPEN_PROJECTS} can be open; close ones you no longer need.`,
    "For larger jobs spanning projects, use delegate_task to give each project its own subagent, and include any shared contract in each task.",
    "Be concise.",
  ].join("\n");
}

// ---------- Paths and permission targets ----------

/** "bakery/src/a.ts" → { project: "bakery", rest: "src/a.ts" } */
function splitPath(p: string) {
  const clean = p.replace(/^(\.\/|\/)+/, "");
  const slash = clean.indexOf("/");
  return slash === -1
    ? { project: clean, rest: "" }
    : { project: clean.slice(0, slash), rest: clean.slice(slash + 1) };
}

/** Checks a file-tool path against the open projects. Throws a helpful error if not allowed. */
function openProjectFor(tool: string, p: string, o: AgentOptions) {
  const { project, rest } = splitPath(p);
  const open = o.projects.find((x) => x.name === project);
  if (!open) {
    const names = o.projects.map((x) => x.name).join(", ") || "none";
    throw new Error(`"${project}" is not open. Paths must start with an open project (open: ${names}).`);
  }
  if (WRITING_FILE_TOOLS.includes(tool) && !open.writable) {
    throw new Error(`${project} is open read-only. Call open_project with writable: true to change it.`);
  }
  return { project, rest };
}

/** A command can change anything in its project, so the project must be open and writable. */
function openProjectForCommand(project: string, o: AgentOptions) {
  if (o.role === "sub") throw new Error("Subagents cannot run commands.");
  const open = o.projects.find((x) => x.name === project);
  if (!open) {
    const names = o.projects.map((x) => x.name).join(", ") || "none";
    throw new Error(`"${project}" is not open. Open it first (open: ${names}).`);
  }
  if (!open.writable) {
    throw new Error(`${project} is open read-only. Call open_project with writable: true to run commands in it.`);
  }
  return project;
}

// ---------- Running one tool call ----------

async function execute(
  call: { id: string; name: string; args: string },
  o: AgentOptions,
  delegateSlot: number,
): Promise<string> {
  try {
    const args = JSON.parse(call.args || "{}");
    const isFileTool = ["list_dir", "read_file", ...WRITING_FILE_TOOLS].includes(call.name);
    const target = isFileTool ? openProjectFor(call.name, String(args.path ?? ""), o) : null;

    const commandProject = call.name === "run_command" ? openProjectForCommand(String(args.project ?? ""), o) : null;

    // Permission: per project for file tools and commands, per workspace for create_project.
    const project = target?.project ?? commandProject;
    const where = project ?? "workspace";
    const scope = project ? `${o.workspace}/${project}` : o.workspace;
    const who = o.who ?? "Main agent";
    // For a full rewrite, fetch the current text so the approval card can show what changes.
    const before =
      call.name === "write_file" && target
        ? await invoke<string>("read_file", { workspace: o.workspace, ...pp(target) }).catch(() => null)
        : undefined;
    const refusal = await checkPermission({ tool: call.name, args, who, where, before }, o.getMode(), scope, o.ask);
    if (refusal) return refusal;

    switch (call.name) {
      case "list_dir": {
        const names = await invoke<string[]>("list_dir", { workspace: o.workspace, ...pp(target) });
        return names.join("\n") || "(empty folder)";
      }
      case "read_file":
        return await invoke<string>("read_file", { workspace: o.workspace, ...pp(target) });
      case "write_file":
        return await invoke<string>("write_file", {
          workspace: o.workspace,
          ...pp(target),
          content: String(args.content ?? ""),
        });
      case "edit_file":
        return await invoke<string>("edit_file", {
          workspace: o.workspace,
          ...pp(target),
          oldText: String(args.old_text ?? ""),
          newText: String(args.new_text ?? ""),
        });
      case "run_command":
        return await invoke<string>("run_command", {
          workspace: o.workspace,
          project: commandProject,
          command: String(args.command ?? ""),
          timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined,
        });
      case "list_projects":
        return await listProjects(o);
      case "open_project":
        return await openProject(String(args.name), args.writable === true, o);
      case "close_project": {
        o.projects.splice(0, o.projects.length, ...o.projects.filter((p) => p.name !== args.name));
        o.onProjectsChange?.([...o.projects]);
        return `Closed ${args.name}.`;
      }
      case "create_project": {
        const name = await invoke<string>("create_project", { workspace: o.workspace, name: String(args.name) });
        return `Created ${name}. ` + (await openProject(name, true, o));
      }
      case "delegate_task":
        if (delegateSlot >= MAX_SUBAGENTS_PER_TURN) {
          return `Refused: at most ${MAX_SUBAGENTS_PER_TURN} subagents per turn. Run this one later.`;
        }
        return await runSubagent(call.id, String(args.project), String(args.task), o);
      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const pp = (t: { project: string; rest: string } | null) => ({ project: t!.project, path: t!.rest });

async function listProjects(o: AgentOptions) {
  type Info = { name: string; modified: number; summary: string };
  const list = await invoke<Info[]>("list_projects", { workspace: o.workspace });
  if (list.length === 0) return "(no projects yet)";
  return list
    .map((p) => {
      const date = new Date(p.modified * 1000).toISOString().slice(0, 10);
      const open = o.projects.some((x) => x.name === p.name) ? " [open]" : "";
      return `${p.name}${open} · changed ${date}${p.summary ? " · " + p.summary : ""}`;
    })
    .join("\n");
}

async function openProject(name: string, writable: boolean, o: AgentOptions) {
  await invoke("check_project", { workspace: o.workspace, name }); // throws if it isn't a real project
  const existing = o.projects.find((p) => p.name === name);
  if (existing) {
    existing.writable = writable;
  } else {
    if (o.projects.length >= MAX_OPEN_PROJECTS) {
      return `Could not open ${name}: ${MAX_OPEN_PROJECTS} projects are already open. Close one first.`;
    }
    o.projects.push({ name, writable });
  }
  o.onProjectsChange?.([...o.projects]);
  return `Opened ${name} (${writable ? "writable" : "read-only"}).`;
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
    run.status = "done";
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
  const tools = o.role === "sub" ? FILE_TOOLS : [...PROJECT_TOOLS, ...SHELL_TOOLS, ...FILE_TOOLS];
  const messages = [...o.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    // 1. Send the conversation (with a fresh system prompt) and stream the reply.
    const system: ChatCompletionMessageParam = { role: "system", content: systemPrompt(o) };
    const stream = await client.chat.completions.create(
      { model: o.model, messages: [system, ...messages], tools, stream: true },
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

  messages.push({ role: "assistant", content: `Stopped after ${MAX_STEPS} steps.` });
  return messages;
}
