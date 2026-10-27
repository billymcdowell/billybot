import { LazyStore } from "@tauri-apps/plugin-store";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// One JSON file in the app's data folder holds everything below.
const store = new LazyStore("harness.json");

export type Mode = "ask" | "acceptEdits" | "readOnly" | "bypass";

/** A project the agent has open in a chat. Read-only unless opened as writable. */
export type OpenProject = { name: string; writable: boolean };

/** One subagent's run, saved with the chat so you can inspect it later. */
export type SubagentRun = {
  project: string;
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  messages: ChatCompletionMessageParam[];
  report?: string;
};

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatCompletionMessageParam[];
  projects: OpenProject[];
  subagents: Record<string, SubagentRun>; // keyed by the delegate_task call id
};

// ---------- Simple settings (workspace, model, mode, polish) ----------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return (await store.get<T>(`setting:${key}`)) ?? fallback;
}

export async function setSetting<T>(key: string, value: T) {
  await store.set(`setting:${key}`, value);
}

// ---------- "Always allow", remembered per project ----------
// `scope` is a project's full path, or the workspace path for create_project.

export async function getAlwaysAllowed(scope: string): Promise<string[]> {
  return (await store.get<string[]>(`allow:${scope}`)) ?? [];
}

export async function addAlwaysAllowed(scope: string, tool: string) {
  const tools = await getAlwaysAllowed(scope);
  if (!tools.includes(tool)) await store.set(`allow:${scope}`, [...tools, tool]);
}

export async function clearAlwaysAllowed(scope: string) {
  await store.delete(`allow:${scope}`);
}

// ---------- Conversations, saved per workspace ----------

export async function listConversations(workspace: string): Promise<Conversation[]> {
  const all = (await store.get<Conversation[]>(`chats:${workspace}`)) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(workspace: string, convo: Conversation) {
  const others = (await listConversations(workspace)).filter((c) => c.id !== convo.id);
  await store.set(`chats:${workspace}`, [convo, ...others]);
}

export async function deleteConversation(workspace: string, id: string) {
  const rest = (await listConversations(workspace)).filter((c) => c.id !== id);
  await store.set(`chats:${workspace}`, rest);
}
