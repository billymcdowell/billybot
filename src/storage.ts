import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatUsage } from "./cost";
import type { Compaction } from "./compaction";
import type { Todo } from "./todos";
import { searchableText, snippetAround } from "./history";

// Small settings, and the "always allow" list, live in one JSON file in the app's data folder.
// Chats don't: each is its own file (see src-tauri/src/chats.rs), so saving one never rewrites
// the others.
const store = new LazyStore("harness.json");

export type Mode = "ask" | "acceptEdits" | "plan" | "readOnly" | "bypass";

/** A project the agent has open in a chat. Read-only unless opened as writable. */
export type OpenProject = { name: string; writable: boolean };

/** One subagent's run, saved with the chat so you can inspect it later. */
export type SubagentRun = {
  project: string;
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  messages: ChatCompletionMessageParam[];
  report?: string;
  streaming?: string; // what it is saying right now
  startedAt?: number;
  endedAt?: number;
  cost?: number; // dollars this subagent has spent
};

export const CHAT_VERSION = 2;

export type Conversation = {
  version?: number; // 2 = stored as its own file; older chats had none
  id: string;
  title: string;
  titleEdited?: boolean; // the user named it, so don't replace the title with the first message
  pinned?: boolean;
  updatedAt: number;
  messages: ChatCompletionMessageParam[];
  projects: OpenProject[];
  subagents: Record<string, SubagentRun>; // keyed by the delegate_task call id
  stopped?: boolean; // the last run ended because the user pressed Stop
  usage?: ChatUsage; // what the chat has cost so far
  budgetExtra?: number; // dollars added to this chat's cap after it ran out
  forkedFrom?: { chatId: string; messageIndex: number }; // set on a chat made with "Fork from here"
  checkpoints?: { run: string; turn: number }[]; // each run that may have changed files, and the turn it answered
  mode?: Mode; // this chat's permission mode; chats saved before modes were per chat have none
  todos?: Todo[]; // the agent's to-do list
  compaction?: Compaction | null; // older messages the model sees as a summary; the messages themselves are all kept
};

/** What the sidebar needs about a chat, kept in an index so listing never opens every chat. */
export type ChatSummary = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  projects: string[];
  messageCount: number;
  cost?: number; // dollars spent in the chat
  forked?: boolean;
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

/** Every project (or workspace) that has tools remembered as "always allow". */
export async function listAlwaysAllowed(): Promise<{ scope: string; tools: string[] }[]> {
  const entries = await store.entries<string[]>();
  return entries
    .filter(([key, tools]) => key.startsWith("allow:") && Array.isArray(tools) && tools.length > 0)
    .map(([key, tools]) => ({ scope: key.slice("allow:".length), tools }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

export async function removeAlwaysAllowed(scope: string, tool: string) {
  const rest = (await getAlwaysAllowed(scope)).filter((t) => t !== tool);
  if (rest.length) await store.set(`allow:${scope}`, rest);
  else await store.delete(`allow:${scope}`);
}

// ---------- Chats, one file each, saved per workspace ----------

const INDEX = "_index";

export const summaryOf = (c: Conversation): ChatSummary => ({
  id: c.id,
  title: c.title,
  pinned: c.pinned === true,
  updatedAt: c.updatedAt,
  projects: (c.projects ?? []).map((p) => p.name),
  messageCount: (c.messages ?? []).length,
  ...(c.usage ? { cost: c.usage.cost } : {}),
  ...(c.forkedFrom ? { forked: true } : {}),
});

/** Pinned chats first, then the most recently changed. */
export const sortChats = (list: ChatSummary[]) =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);

// Saving a chat is write-the-chat then update-the-index. Running those one job at a time
// keeps two saves (or a save and a rename) from overwriting each other's index.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

function parseChat(text: string | null): Conversation | null {
  if (!text) return null;
  try {
    const c = JSON.parse(text);
    if (!c || typeof c.id !== "string" || !Array.isArray(c.messages)) return null;
    return {
      ...c,
      title: typeof c.title === "string" ? c.title : "New chat",
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      projects: Array.isArray(c.projects) ? c.projects : [],
      subagents: c.subagents && typeof c.subagents === "object" ? c.subagents : {},
    };
  } catch {
    return null;
  }
}

const readChat = async (workspace: string, id: string) =>
  parseChat(await invoke<string | null>("chat_read", { workspace, name: id }));

async function readIndex(workspace: string): Promise<ChatSummary[]> {
  try {
    const text = await invoke<string | null>("chat_read", { workspace, name: INDEX });
    const parsed = text ? JSON.parse(text) : null;
    return Array.isArray(parsed?.chats) ? parsed.chats : [];
  } catch {
    return []; // a damaged index is rebuilt from the chat files
  }
}

const writeIndex = (workspace: string, chats: ChatSummary[]) =>
  invoke("chat_write", { workspace, name: INDEX, data: JSON.stringify({ version: 1, chats }) });

const migrated = new Set<string>();

/**
 * Chats used to be one list inside harness.json. Copy any that are left into their own files,
 * and delete the old list only once every one reads back with the same number of messages.
 */
async function migrateOldChats(workspace: string) {
  if (migrated.has(workspace)) return;
  const key = `chats:${workspace}`;
  const old = await store.get<Conversation[]>(key);
  if (!Array.isArray(old) || old.length === 0) {
    migrated.add(workspace);
    return;
  }
  const have = new Set(await invoke<string[]>("chat_names", { workspace }));
  for (const c of old) {
    if (!c?.id || have.has(c.id)) continue;
    await invoke("chat_write", { workspace, name: c.id, data: JSON.stringify({ ...c, version: CHAT_VERSION }) });
  }
  for (const c of old) {
    const back = await readChat(workspace, c.id);
    if (!back || back.messages.length !== (c.messages ?? []).length) {
      console.error(`Chat migration: ${c.id} did not read back correctly; keeping the old copy.`);
      return; // try again next time; nothing has been deleted
    }
  }
  await store.delete(key);
  await store.save();
  migrated.add(workspace);
}

/** The workspace's chats, newest first with pinned ones on top. Rebuilds the index if it is out of step with the files. */
export function listChats(workspace: string): Promise<ChatSummary[]> {
  return serial(async () => {
    await migrateOldChats(workspace);
    const names = (await invoke<string[]>("chat_names", { workspace })).filter((n) => n !== INDEX);
    const index = await readIndex(workspace);
    const known = new Map(index.map((s) => [s.id, s]));
    let changed = index.length !== names.length;
    const chats: ChatSummary[] = [];
    for (const id of names) {
      const hit = known.get(id);
      if (hit) {
        chats.push(hit);
        continue;
      }
      const c = await readChat(workspace, id);
      if (c) chats.push(summaryOf(c));
      changed = true;
    }
    if (changed) await writeIndex(workspace, chats);
    return sortChats(chats);
  });
}

export const loadChat = (workspace: string, id: string) => readChat(workspace, id);

export function saveConversation(workspace: string, convo: Conversation): Promise<void> {
  return serial(async () => {
    const saved = { ...convo, version: CHAT_VERSION };
    await invoke("chat_write", { workspace, name: convo.id, data: JSON.stringify(saved) });
    const index = (await readIndex(workspace)).filter((s) => s.id !== convo.id);
    await writeIndex(workspace, [summaryOf(saved), ...index]);
  });
}

export function deleteConversation(workspace: string, id: string): Promise<void> {
  return serial(async () => {
    await invoke("chat_delete", { workspace, name: id });
    await writeIndex(workspace, (await readIndex(workspace)).filter((s) => s.id !== id));
  });
}

/** Change a chat's name or pin without touching its messages. */
export async function updateChatMeta(
  workspace: string,
  id: string,
  change: { title?: string; pinned?: boolean; budgetExtra?: number },
): Promise<void> {
  const convo = await readChat(workspace, id);
  if (!convo) return;
  const title = change.title?.trim();
  await saveConversation(workspace, {
    ...convo,
    ...(title ? { title: title.slice(0, 100), titleEdited: true } : {}),
    ...(change.pinned === undefined ? {} : { pinned: change.pinned }),
    ...(change.budgetExtra === undefined ? {} : { budgetExtra: change.budgetExtra }),
    updatedAt: convo.updatedAt, // renaming isn't activity: don't move the chat to the top
  });
}

export type SearchHit = { id: string; snippet: string };

/** Chats whose messages (not tool output) contain `query`, with a bit of text around the match. */
export async function searchChats(workspace: string, query: string, limit = 50): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const names = (await invoke<string[]>("chat_names", { workspace })).filter((n) => n !== INDEX);
  const hits: (SearchHit & { updatedAt: number })[] = [];
  for (const id of names) {
    const c = await readChat(workspace, id);
    const snippet = c && snippetAround(searchableText(c.messages), q);
    if (c && snippet) hits.push({ id, snippet, updatedAt: c.updatedAt });
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map(({ id, snippet }) => ({ id, snippet }));
}
