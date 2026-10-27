import { LazyStore } from "@tauri-apps/plugin-store";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// One JSON file in the app's data folder holds everything below.
const store = new LazyStore("harness.json");

export type Mode = "ask" | "acceptEdits" | "readOnly" | "bypass";

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatCompletionMessageParam[];
};

// ---------- Simple settings (last folder, model, mode) ----------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return (await store.get<T>(`setting:${key}`)) ?? fallback;
}

export async function setSetting<T>(key: string, value: T) {
  await store.set(`setting:${key}`, value);
}

// ---------- "Always allow", remembered per folder ----------

export async function getAlwaysAllowed(folder: string): Promise<string[]> {
  return (await store.get<string[]>(`allow:${folder}`)) ?? [];
}

export async function addAlwaysAllowed(folder: string, tool: string) {
  const tools = await getAlwaysAllowed(folder);
  if (!tools.includes(tool)) await store.set(`allow:${folder}`, [...tools, tool]);
}

export async function clearAlwaysAllowed(folder: string) {
  await store.delete(`allow:${folder}`);
}

// ---------- Conversations, saved per folder ----------

export async function listConversations(folder: string): Promise<Conversation[]> {
  const all = (await store.get<Conversation[]>(`chats:${folder}`)) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(folder: string, convo: Conversation) {
  const others = (await listConversations(folder)).filter((c) => c.id !== convo.id);
  await store.set(`chats:${folder}`, [convo, ...others]);
}

export async function deleteConversation(folder: string, id: string) {
  const rest = (await listConversations(folder)).filter((c) => c.id !== id);
  await store.set(`chats:${folder}`, rest);
}
