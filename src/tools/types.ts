import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
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
  // Token counts the API reports for each request (main agent only).
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  signal?: AbortSignal;
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
  /** Text to show on the approval card as "before", or null if there is none. */
  preview?: (args: ToolArgs, target: Target | null, o: AgentOptions) => Promise<string | null>;
  run: (args: ToolArgs, target: Target | null, ctx: ToolContext) => Promise<string>;
};
