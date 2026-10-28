import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";

// The Tauri store plugin and the Rust chat commands, replaced by in-memory versions.
const settings = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = async (k: string) => settings.get(k);
    set = async (k: string, v: unknown) => void settings.set(k, v);
    delete = async (k: string) => void settings.delete(k);
    entries = async () => [...settings.entries()];
    save = async () => {};
  },
}));

const files = new Map<string, string>(); // "workspace|name" → text
let corruptWrites = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: { workspace: string; name?: string; data?: string }) => {
    const key = `${a.workspace}|${a.name}`;
    if (cmd === "chat_write") {
      files.set(key, corruptWrites ? JSON.stringify({ id: a.name, messages: [] }) : a.data!);
      return;
    }
    if (cmd === "chat_read") return files.get(key) ?? null;
    if (cmd === "chat_delete") return void files.delete(key);
    if (cmd === "chat_names") {
      return [...files.keys()].filter((k) => k.startsWith(`${a.workspace}|`)).map((k) => k.split("|")[1]).sort();
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));

import {
  addAlwaysAllowed, deleteConversation, listAlwaysAllowed, listChats, removeAlwaysAllowed, loadChat, saveConversation, searchChats, updateChatMeta, type Conversation,
} from "./storage";

let n = 0;
let ws = "";
beforeEach(() => {
  settings.clear();
  files.clear();
  corruptWrites = false;
  ws = `/ws/test-${++n}`; // the migration is remembered per workspace, so each test gets its own
});

const user = (content: string): Msg => ({ role: "user", content });
const reply = (content: string): Msg => ({ role: "assistant", content });
const chat = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, title: `chat ${id}`, updatedAt: 100, messages: [user("hello"), reply("hi")], projects: [{ name: "app", writable: true }], subagents: {}, ...over,
});

describe("saving and loading", () => {
  it("round-trips a chat and lists a summary of it", async () => {
    await saveConversation(ws, chat("a"));
    expect(await loadChat(ws, "a")).toMatchObject({ id: "a", version: 2, messages: [user("hello"), reply("hi")] });
    expect(await listChats(ws)).toEqual([
      { id: "a", title: "chat a", pinned: false, updatedAt: 100, projects: ["app"], messageCount: 2 },
    ]);
  });

  it("saving again replaces the chat instead of adding another", async () => {
    await saveConversation(ws, chat("a"));
    await saveConversation(ws, chat("a", { title: "renamed", messages: [user("x")] }));
    const list = await listChats(ws);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "renamed", messageCount: 1 });
  });

  it("keeps every chat when many are saved at once", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveConversation(ws, chat(`c${i}`, { updatedAt: i }))));
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["c7", "c6", "c5", "c4", "c3", "c2", "c1", "c0"]);
  });

  it("returns null for a chat that is missing or unreadable", async () => {
    expect(await loadChat(ws, "nope")).toBeNull();
    files.set(`${ws}|bad`, "{not json");
    files.set(`${ws}|odd`, JSON.stringify({ id: 5 }));
    expect(await loadChat(ws, "bad")).toBeNull();
    expect(await loadChat(ws, "odd")).toBeNull();
  });

  it("fills in fields an older or partial file is missing", async () => {
    files.set(`${ws}|old`, JSON.stringify({ id: "old", messages: [user("x")] }));
    expect(await loadChat(ws, "old")).toMatchObject({ title: "New chat", projects: [], subagents: {}, updatedAt: 0 });
  });

  it("deletes a chat and its index entry", async () => {
    await saveConversation(ws, chat("a"));
    await saveConversation(ws, chat("b"));
    await deleteConversation(ws, "a");
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["b"]);
    expect(await loadChat(ws, "a")).toBeNull();
  });

  it("keeps different workspaces apart", async () => {
    await saveConversation(ws, chat("a"));
    expect(await listChats(`${ws}-other`)).toEqual([]);
  });
});

describe("cost and forks in the list", () => {
  it("shows what a chat cost and whether it is a fork", async () => {
    const usage = { cost: 0.42, promptTokens: 1, completionTokens: 1, requests: 1, estimated: 0, unpriced: 0, turns: {} };
    await saveConversation(ws, chat("a", { usage, forkedFrom: { chatId: "x", messageIndex: 2 }, budgetExtra: 3 }));
    expect(await listChats(ws)).toEqual([expect.objectContaining({ id: "a", cost: 0.42, forked: true })]);
    expect(await loadChat(ws, "a")).toMatchObject({ usage, budgetExtra: 3, forkedFrom: { chatId: "x", messageIndex: 2 } });
  });

  it("can grant extra budget without touching anything else", async () => {
    await saveConversation(ws, chat("a", { updatedAt: 7 }));
    await updateChatMeta(ws, "a", { budgetExtra: 5 });
    expect(await loadChat(ws, "a")).toMatchObject({ budgetExtra: 5, updatedAt: 7, title: "chat a" });
  });
});

describe("listing", () => {
  it("puts pinned chats first, then newest first", async () => {
    await saveConversation(ws, chat("old", { updatedAt: 1 }));
    await saveConversation(ws, chat("new", { updatedAt: 9 }));
    await saveConversation(ws, chat("pinned", { updatedAt: 5, pinned: true }));
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["pinned", "new", "old"]);
  });

  it("rebuilds a missing or damaged index from the chat files", async () => {
    await saveConversation(ws, chat("a"));
    await saveConversation(ws, chat("b", { updatedAt: 200 }));
    files.delete(`${ws}|_index`);
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["b", "a"]);
    files.set(`${ws}|_index`, "garbage");
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["b", "a"]);
    expect(JSON.parse(files.get(`${ws}|_index`)!).chats).toHaveLength(2);
  });

  it("drops index entries whose file is gone, and skips files it can't read", async () => {
    await saveConversation(ws, chat("a"));
    await saveConversation(ws, chat("b"));
    files.delete(`${ws}|a`);
    files.set(`${ws}|junk`, "{nope");
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["b"]);
  });

  it("picks up a chat file that never made it into the index", async () => {
    files.set(`${ws}|late`, JSON.stringify(chat("late")));
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["late"]);
  });
});

describe("renaming and pinning", () => {
  it("renames without moving the chat or touching its messages", async () => {
    await saveConversation(ws, chat("a", { updatedAt: 50 }));
    await updateChatMeta(ws, "a", { title: "  My chat  " });
    expect(await loadChat(ws, "a")).toMatchObject({ title: "My chat", titleEdited: true, updatedAt: 50, messages: [user("hello"), reply("hi")] });
    expect((await listChats(ws))[0].title).toBe("My chat");
  });

  it("ignores a blank name and pins and unpins", async () => {
    await saveConversation(ws, chat("a"));
    await updateChatMeta(ws, "a", { title: "   " });
    expect((await loadChat(ws, "a"))!.titleEdited).toBeUndefined();
    await updateChatMeta(ws, "a", { pinned: true });
    expect((await listChats(ws))[0].pinned).toBe(true);
    await updateChatMeta(ws, "a", { pinned: false });
    expect((await listChats(ws))[0].pinned).toBe(false);
  });

  it("does nothing for a chat that doesn't exist", async () => {
    await updateChatMeta(ws, "ghost", { title: "x" });
    expect(await listChats(ws)).toEqual([]);
  });
});

describe("search", () => {
  it("finds chats by what was said, newest first, with a snippet", async () => {
    await saveConversation(ws, chat("a", { updatedAt: 1, messages: [user("fix the Login bug"), reply("done")] }));
    await saveConversation(ws, chat("b", { updatedAt: 2, messages: [user("hello"), reply("the login page is ready")] }));
    await saveConversation(ws, chat("c", { updatedAt: 3, messages: [user("unrelated"), reply("nothing")] }));
    const hits = await searchChats(ws, "login");
    expect(hits.map((h) => h.id)).toEqual(["b", "a"]);
    expect(hits[0].snippet).toContain("login page");
  });

  it("returns nothing for a blank query or no match", async () => {
    await saveConversation(ws, chat("a"));
    expect(await searchChats(ws, "  ")).toEqual([]);
    expect(await searchChats(ws, "zzz")).toEqual([]);
  });
});

describe("moving chats out of harness.json", () => {
  it("copies old chats into their own files, then removes the old list", async () => {
    settings.set(`chats:${ws}`, [chat("a"), chat("b", { updatedAt: 200 })]);
    expect((await listChats(ws)).map((c) => c.id)).toEqual(["b", "a"]);
    expect(await loadChat(ws, "a")).toMatchObject({ version: 2, messages: [user("hello"), reply("hi")] });
    expect(settings.has(`chats:${ws}`)).toBe(false);
  });

  it("keeps the old list if a copy doesn't read back the same", async () => {
    settings.set(`chats:${ws}`, [chat("a")]);
    corruptWrites = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await listChats(ws);
    expect(settings.has(`chats:${ws}`)).toBe(true);
  });

  it("doesn't overwrite a chat that already has its own file", async () => {
    settings.set(`chats:${ws}`, [chat("a", { title: "old copy" })]);
    files.set(`${ws}|a`, JSON.stringify(chat("a", { title: "newer copy" })));
    await listChats(ws);
    expect((await loadChat(ws, "a"))!.title).toBe("newer copy");
    expect(settings.has(`chats:${ws}`)).toBe(false);
  });

  it("does nothing when there is nothing to move", async () => {
    expect(await listChats(ws)).toEqual([]);
  });
});

describe("always allowed", () => {
  it("lists every scope with its tools, and ignores other settings", async () => {
    settings.set("setting:model", "x");
    await addAlwaysAllowed("/ws/b", "edit_file");
    await addAlwaysAllowed("/ws/a", "write_file");
    await addAlwaysAllowed("/ws/a", "edit_file");
    await addAlwaysAllowed("/ws/a", "edit_file");
    expect(await listAlwaysAllowed()).toEqual([
      { scope: "/ws/a", tools: ["write_file", "edit_file"] },
      { scope: "/ws/b", tools: ["edit_file"] },
    ]);
  });

  it("takes one tool back, and forgets the scope when none are left", async () => {
    await addAlwaysAllowed("/ws/a", "write_file");
    await addAlwaysAllowed("/ws/a", "edit_file");
    await removeAlwaysAllowed("/ws/a", "write_file");
    expect(await listAlwaysAllowed()).toEqual([{ scope: "/ws/a", tools: ["edit_file"] }]);
    await removeAlwaysAllowed("/ws/a", "edit_file");
    expect(await listAlwaysAllowed()).toEqual([]);
    expect(settings.has("allow:/ws/a")).toBe(false);
    await removeAlwaysAllowed("/ws/none", "x"); // nothing to remove: fine
  });
});
