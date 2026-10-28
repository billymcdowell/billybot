import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ActivityDraft } from "../activity";
import type { Compaction } from "../compaction";
import type { UsageEvent } from "../cost";
import type { Todo } from "../todos";
import type { Limits } from "../limits";
import type { AskFn, ToolCategory } from "../permissions";
import type { Mode, OpenProject, SubagentRun } from "../storage";

export type AgentRole = "main" | "sub";

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
  // What the API reports for each request, from this agent and (since they inherit it) its subagents.
  onUsage?: (usage: UsageEvent) => void;
  // Returns the spending cap if the chat has reached it, so the agent stops before its next request.
  overBudget?: () => number | null;
  // Messages the user sent while the agent was working; asked for before each step (main agent only).
  takeSteering?: () => string[];
  signal?: AbortSignal;
  // Everything the agent does, for the activity log. Subagents inherit it and mark theirs with a depth.
  onEvent?: (event: ActivityDraft) => void;
  // Names this run, so Stop can cancel its commands and no one else's.
  runKey?: string;
  // Which chat and run a file change belongs to, so Rust can keep an undo copy of what it replaces.
  checkpoint?: { chatId: string; runId: string };
  // Called before a file change in a project goes ahead (after any approval). The app uses it to put a chat on its own git branch. A failure never blocks the change.
  beforeWrite?: (project: string) => Promise<void>;
  // The agent's to-do list changed.
  onTodos?: (items: Todo[]) => void;
  // Asks the user a question and waits. Returns their answer, or null if the run was stopped first.
  askUser?: (q: { question: string; options: string[] }) => Promise<string | null>;
  // Set on a subagent: the delegate_task call that started it, so its cost and approvals can be told apart.
  subagentCallId?: string;
  // A subagent registers a way to stop just itself (null when it ends).
  registerSubagent?: (callId: string, stop: (() => void) | null) => void;
  // Making room when the conversation outgrows the model's context window (main agent only):
  compaction?: Compaction | null; // what has been compacted already
  contextWindow?: number; // the model's window in tokens, if known
  compactAt?: number; // the share of the window (0 to 1) at which to compact; default 0.8
  // Summarizes the older messages. Returns the new compaction, or null if there was nothing to do.
  compact?: (messages: ChatCompletionMessageParam[], current: Compaction | null) => Promise<Compaction | null>;
  redact?: boolean; // hide secrets from the model (default true)
  limits?: Partial<Limits>; // see src/limits.ts; missing values use the defaults
  role?: AgentRole;
  who?: string; // shown on approval cards
};

export type ToolArgs = Record<string, unknown>;

/** The project (and path inside it) a call works on, after it has been checked against the open projects. */
export type Target = { project: string; rest: string };

export type ToolContext = {
  o: AgentOptions;
  callId: string;
  delegateSlot: number; // how many delegate_task calls started before this one in the turn
  runSubagent: (callId: string, project: string, task: string) => Promise<string>;
};

export type Tool = {
  name: string;
  /** What the model sees. */
  definition: ChatCompletionTool;
  /** Decides which permission rule applies. */
  category: ToolCategory;
  /** Which agents are given the tool, and may call it. */
  roles: AgentRole[];
  /** Safe to run at the same time as other parallel-safe tools: no prompts, no side effects. */
  parallelSafe: boolean;
  /** Said to a subagent that calls a tool it was not given. */
  subagentRefusal?: string;
  /** Checks the call against the open projects (throws a helpful error if not allowed). Omit for workspace-level tools. */
  target?: (args: ToolArgs, o: AgentOptions) => Target;
  /** Extra checks on a call, shown on the approval card. `danger` makes the call ask even in Bypass mode. */
  risk?: (args: ToolArgs) => { danger?: string; warning?: string };
  /** Text to show on the approval card as "before", or null if there is none. */
  preview?: (args: ToolArgs, target: Target | null, o: AgentOptions) => Promise<string | null>;
  run: (args: ToolArgs, target: Target | null, ctx: ToolContext) => Promise<string>;
};
