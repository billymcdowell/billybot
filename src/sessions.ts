// Chats that work in the background.
//
// Each chat that is open (or has an agent working) is a *session*: its messages, projects, cost,
// approvals waiting on you, queued messages, undo runs, activity log and the agent run itself.
// The screen shows one session; the others carry on without it. Switching chats changes which
// session is shown, never what any of them is doing. This file has no React in it apart from two
// small hooks at the bottom, so all of it can be tested.

import { useSyncExternalStore } from "react";
import { makeEvent, mergeEvents, upsertEvent, type ActivityDraft, type ActivityEvent } from "./activity";
import { runAgent } from "./agent";
import { changedByTurn, runsFrom, summarizeRevert, type CheckpointRun, type RevertResult } from "./checkpoints";
import { addUsage, budgetState, effectiveCap, emptyUsage, formatCost, type ChatUsage } from "./cost";
import type { GitInfo } from "./git";
import { branchName, isChatBranch, isShowable } from "./git";
import {
  autoTitle, forkMessages, repairMessages, repairSubagents, runState,
} from "./history";
import type { Limits } from "./limits";
import type { ModelInfo } from "./models";
import { MODES, type Approval, type ApprovalRequest } from "./permissions";
import type { Conversation, Mode, OpenProject, SubagentRun } from "./storage";
import type { AgentOptions } from "./tools/types";

type Msg = Conversation["messages"][number];

// ---------- The state of one chat ----------

/** What the chat has remembered about itself besides its messages. */
export type ChatMeta = {
  title?: string;
  titleEdited?: boolean; // you named it, so don't replace the title with the first message
  pinned?: boolean;
  budgetExtra?: number;
  forkedFrom?: { chatId: string; messageIndex: number };
};

/** A message typed while the agent was working. `steering` ones join the run at its next step. */
export type Queued = { id: string; text: string; steering?: boolean };

/** An approval the agent is waiting on. */
export type Pending = { id: string; req: ApprovalRequest; resolve: (answer: Approval) => void };

/** waiting = lined up for a free slot (too many chats are working); running = an agent is working. */
export type Phase = "idle" | "waiting" | "running";

export type Session = {
  id: string;
  meta: ChatMeta;
  messages: Msg[];
  projects: OpenProject[];
  subagents: Record<string, SubagentRun>;
  streaming: string;
  usage: ChatUsage;
  lastUsage: { promptTokens: number; completionTokens: number } | null;
  events: ActivityEvent[];
  queue: Queued[];
  runs: CheckpointRun[];
  changed: Record<string, number>; // files each turn changed, which can be undone
  approvals: Pending[];
  phase: Phase;
  stopped: boolean; // the last run ended because Stop was pressed
  closedMidRun: boolean; // the app was closed while this chat was working
  error: string;
  notice: string;
  mode: Mode;
  draft: string;
  /** Something happened here while you were looking at another chat. */
  attention: "done" | "failed" | null;
  touched: number; // when you last looked at it, for deciding which idle sessions to let go
  updatedAt: number; // when the chat last had activity, as saved
};

export type SessionSummary = { phase: Phase; needsYou: boolean; attention: Session["attention"] };

// Tools whose effects Regenerate can't take back.
export const ACTING_TOOLS = ["write_file", "edit_file", "multi_edit", "run_command", "create_project"];

/** True if the agent changed files or ran commands in these messages. */
export const actedIn = (msgs: Msg[]) =>
  msgs.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.type === "function" && ACTING_TOOLS.includes(c.function.name)));

export const titleOf = (s: Pick<Session, "meta" | "messages">) =>
  s.meta.titleEdited && s.meta.title ? s.meta.title : autoTitle(s.messages);

/** A chat with nothing in it. */
export function blankSession(id: string, mode: Mode, now: number): Session {
  return {
    id, meta: {}, messages: [], projects: [], subagents: {}, streaming: "", usage: emptyUsage(), lastUsage: null, events: [],
    queue: [], runs: [], changed: {}, approvals: [], phase: "idle", stopped: false, closedMidRun: false, error: "", notice: "",
    mode, draft: "", attention: null, touched: now, updatedAt: now,
  };
}

export const isBusy = (s: Pick<Session, "phase"> | undefined) => !!s && s.phase !== "idle";

/** Everything a saved chat holds. */
export function toConversation(s: Session, updatedAt: number): Conversation {
  return {
    id: s.id,
    title: titleOf(s),
    titleEdited: s.meta.titleEdited,
    pinned: s.meta.pinned,
    updatedAt,
    messages: s.messages,
    projects: s.projects,
    subagents: s.subagents,
    stopped: s.stopped,
    usage: s.usage,
    budgetExtra: s.meta.budgetExtra,
    forkedFrom: s.meta.forkedFrom,
    checkpoints: s.runs,
    mode: s.mode,
  };
}

// ---------- The store ----------

/** Holds every session. Components subscribe to one session, or to the short summaries the sidebar needs. */
export class SessionStore {
  private map = new Map<string, Session>();
  private listeners = new Set<() => void>();
  private summaries: ReadonlyMap<string, SessionSummary> = new Map();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  get = (id: string) => this.map.get(id);
  has = (id: string) => this.map.has(id);
  all = () => [...this.map.values()];
  getSummaries = () => this.summaries;

  put(session: Session) {
    this.map.set(session.id, session);
    this.changed(session.id);
  }

  update(id: string, change: Partial<Session> | ((s: Session) => Partial<Session>)) {
    const s = this.map.get(id);
    if (!s) return;
    this.map.set(id, { ...s, ...(typeof change === "function" ? change(s) : change) });
    this.changed(id);
  }

  delete(id: string) {
    if (this.map.delete(id)) this.changed(id);
  }

  clear() {
    const ids = [...this.map.keys()];
    this.map.clear();
    ids.forEach((id) => this.changed(id));
  }

  private changed(id: string) {
    const s = this.map.get(id);
    const before = this.summaries.get(id);
    const next: SessionSummary | undefined = s ? { phase: s.phase, needsYou: s.approvals.length > 0, attention: s.attention } : undefined;
    const same = before && next && before.phase === next.phase && before.needsYou === next.needsYou && before.attention === next.attention;
    if (!same && (before || next)) {
      const copy = new Map(this.summaries);
      if (next) copy.set(id, next);
      else copy.delete(id);
      this.summaries = copy;
    }
    this.listeners.forEach((l) => l());
  }
}

/** The session for a chat, re-rendering the component whenever that session changes. */
export const useSession = (store: SessionStore, id: string) => useSyncExternalStore(store.subscribe, () => store.get(id));
/** Which chats are working, waiting on you, or have news. Only changes when one of those does. */
export const useSummaries = (store: SessionStore) => useSyncExternalStore(store.subscribe, store.getSummaries);

// ---------- What the controller needs from the outside ----------

export type Deps = {
  runAgent: (o: AgentOptions) => Promise<Msg[]>;
  apiKey: () => string | null;
  workspace: () => string | null;
  model: () => string;
  limits: () => Limits;
  redact: () => boolean;
  branchPerChat: () => boolean;
  defaultMode: () => Mode;
  modelInfo: (id: string) => ModelInfo | undefined;
  saveChat: (workspace: string, chat: Conversation) => Promise<void>;
  saveActivity: (event: ActivityEvent) => void;
  loadActivity: (chatId: string) => Promise<ActivityEvent[]>;
  chatsChanged: () => void;
  gitStatus: (workspace: string, project: string) => Promise<GitInfo>;
  gitCreateBranch: (workspace: string, project: string, name: string) => Promise<void>;
  gitChanged: (projects: string[]) => void;
  checkpointStatus: (chatId: string, runs: CheckpointRun[]) => Promise<{ runId: string; files: number }[]>;
  revertRuns: (chatId: string, runIds: string[], force: boolean) => Promise<RevertResult>;
  cancelCommands: (runKey: string) => void;
  notify: (title: string, body: string) => void;
  now: () => number;
  newId: () => string;
};

type ActiveRun = { abort: AbortController; runKey: string };

export type RunOptions = {
  meta?: ChatMeta;
  subagents?: Record<string, SubagentRun>;
  usage?: ChatUsage;
};

const MAX_IDLE_SESSIONS = 8;

/** Starts, stops and changes chats. Holds nothing a component renders; that is all in the store. */
export class SessionController {
  private active = new Map<string, ActiveRun>();
  private running = 0; // chats using a slot
  private slotQueue: { id: string; grant: (got: boolean) => void }[] = [];
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loadedActivity = new Set<string>();
  private warned = new Map<string, { context: Set<number>; budget: boolean }>();
  private branched = new Set<string>(); // "chat:project" pairs handled already
  displayed: string | null = null;

  constructor(
    readonly store: SessionStore,
    private deps: Deps,
  ) {}

  // ----- creating and showing sessions -----

  private blank(id: string): Session {
    return blankSession(id, this.deps.defaultMode(), this.deps.now());
  }

  /** A new, empty chat. */
  create(id = this.deps.newId()): Session {
    const s = this.blank(id);
    this.store.put(s);
    return s;
  }

  /** The session for a saved chat: the live one if it exists (it may be working right now), otherwise built from what was saved. */
  ensure(c: Conversation): Session {
    const live = this.store.get(c.id);
    if (live) return live;
    // A chat cut off by closing the app can have tool calls with no results, which the API refuses.
    const fixed = repairMessages(c.messages);
    const subs = repairSubagents(c.subagents);
    const s: Session = {
      ...this.blank(c.id),
      meta: { title: c.title, titleEdited: c.titleEdited, pinned: c.pinned, budgetExtra: c.budgetExtra, forkedFrom: c.forkedFrom },
      messages: fixed.messages,
      projects: c.projects,
      subagents: subs.subagents,
      usage: c.usage ?? emptyUsage(),
      runs: c.checkpoints ?? [],
      stopped: c.stopped === true,
      closedMidRun: fixed.repaired || subs.repaired,
      mode: c.mode ?? this.deps.defaultMode(),
      updatedAt: c.updatedAt,
    };
    this.store.put(s);
    return s;
  }

  /** The chat on screen changed. Clears its "something happened" mark and loads what the screen needs. */
  activate(id: string) {
    this.displayed = id;
    this.store.update(id, { attention: null, touched: this.deps.now() });
    if (!this.loadedActivity.has(id) && (this.store.get(id)?.messages.length ?? 0) > 0) {
      this.loadedActivity.add(id);
      void this.deps.loadActivity(id).then((saved) => {
        if (this.store.has(id)) this.store.update(id, (s) => ({ events: mergeEvents(saved, s.events) }));
      });
    }
    void this.refreshChanged(id);
    this.trim();
  }

  /** Lets go of idle sessions nobody is looking at, so memory doesn't grow with every chat you open. */
  private trim() {
    const idle = this.store
      .all()
      .filter((s) => s.id !== this.displayed && s.phase === "idle" && !s.draft && s.queue.length === 0 && s.approvals.length === 0 && !s.attention)
      .sort((a, b) => b.touched - a.touched);
    for (const s of idle.slice(MAX_IDLE_SESSIONS)) {
      this.store.delete(s.id);
      this.loadedActivity.delete(s.id);
      this.warned.delete(s.id);
    }
  }

  // ----- counting -----

  runningIds = () => this.store.all().filter((s) => s.phase !== "idle").map((s) => s.id);
  anyRunning = () => this.store.all().some((s) => s.phase !== "idle");
  needingYou = () => this.store.all().filter((s) => s.approvals.length > 0).map((s) => s.id);

  // ----- small changes to a session -----

  setDraft(id: string, draft: string) {
    this.store.update(id, { draft });
  }
  appendDraft(id: string, text: string) {
    this.store.update(id, (s) => ({ draft: (s.draft.trim() ? s.draft.trimEnd() + " " : "") + text }));
  }
  setError(id: string, error: string) {
    this.store.update(id, { error });
  }
  setNotice(id: string, notice: string) {
    this.store.update(id, { notice });
  }
  setProjects(id: string, change: (p: OpenProject[]) => OpenProject[]) {
    if (!isBusy(this.store.get(id))) this.store.update(id, (s) => ({ projects: change(s.projects) }));
  }
  clearEvents(id: string) {
    this.store.update(id, { events: [] });
  }

  /** This chat's permission mode. Takes effect on the agent's very next tool call. */
  setMode(id: string, mode: Mode, byUser = false) {
    this.store.update(id, { mode });
    if (byUser) {
      this.emit(id, { category: "chat", summary: `Mode changed to ${MODES.find((m) => m.id === mode)?.label ?? mode}` });
      this.saveNow(id);
    }
  }

  /** Rename, pin, or raise the budget. Goes through the session, so it can't clash with the chat saving itself as it works. */
  updateMeta(id: string, change: { title?: string; pinned?: boolean; budgetExtra?: number }) {
    const title = change.title?.trim();
    this.store.update(id, (s) => ({
      meta: {
        ...s.meta,
        ...(title ? { title: title.slice(0, 100), titleEdited: true } : {}),
        ...(change.pinned === undefined ? {} : { pinned: change.pinned }),
        ...(change.budgetExtra === undefined ? {} : { budgetExtra: change.budgetExtra }),
      },
    }));
    this.saveNow(id, false);
  }

  /** Forget a session whose chat was deleted. Refused while it is working. */
  remove(id: string): boolean {
    if (isBusy(this.store.get(id))) return false;
    this.store.delete(id);
    this.loadedActivity.delete(id);
    this.warned.delete(id);
    return true;
  }

  /** Stop everything and forget every session. For switching workspace, after you've agreed. */
  reset() {
    this.stopAll();
    this.store.clear();
    this.loadedActivity.clear();
    this.warned.clear();
    this.branched.clear();
    this.displayed = null;
  }

  // ----- the activity log -----

  emit(id: string, draft: ActivityDraft) {
    const event = makeEvent(draft, id, this.deps.now(), this.deps.newId());
    let merged = event;
    this.store.update(id, (s) => {
      const events = upsertEvent(s.events, event);
      if (event.ref) merged = events.find((e) => e.ref === event.ref && e.chatId === id) ?? event;
      return { events };
    });
    if (!event.pending) this.deps.saveActivity(merged);
  }

  // ----- saving -----

  /** The chat as it would be saved. `touch` says whether this counts as activity, which moves it up the list. */
  snapshot(id: string, touch = true): Conversation | null {
    const s = this.store.get(id);
    return s ? toConversation(s, touch ? this.deps.now() : s.updatedAt) : null;
  }

  /** Saves the chat now, if it has anything in it. `touch` is whether this counts as activity (moves it up the list). */
  saveNow(id: string, touch = true): Promise<void> {
    const ws = this.deps.workspace();
    const s = this.store.get(id);
    if (!ws || !s || s.messages.length === 0) return Promise.resolve();
    return this.deps.saveChat(ws, this.snapshot(id, touch)!).then(() => this.deps.chatsChanged());
  }

  private saveSoon(id: string) {
    if (this.saveTimers.has(id)) return;
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id);
        const ws = this.deps.workspace();
        const snap = this.snapshot(id);
        if (ws && snap) this.deps.saveChat(ws, snap).catch(() => {});
      }, 2000),
    );
  }

  // ----- slots: only so many chats work at once -----

  private acquire(id: string): Promise<boolean> {
    if (this.running < this.deps.limits().maxConcurrentRuns) {
      this.running++;
      return Promise.resolve(true);
    }
    this.store.update(id, { phase: "waiting" });
    return new Promise((grant) => this.slotQueue.push({ id, grant }));
  }

  private release() {
    this.running--;
    while (this.slotQueue.length && this.running < this.deps.limits().maxConcurrentRuns) {
      this.running++;
      this.slotQueue.shift()!.grant(true);
    }
  }

  // ----- Stop -----

  stop(id: string) {
    const run = this.active.get(id);
    if (!run) return;
    run.abort.abort();
    this.deps.cancelCommands(run.runKey); // this run's commands only
    const waiting = this.slotQueue.findIndex((w) => w.id === id);
    if (waiting !== -1) this.slotQueue.splice(waiting, 1)[0].grant(false);
    const s = this.store.get(id);
    s?.approvals.forEach((p) => p.resolve("deny")); // unblocks anything waiting on you
    this.store.update(id, { approvals: [] });
  }

  stopAll() {
    for (const id of [...this.active.keys()]) this.stop(id);
  }

  // ----- approvals -----

  /** The agent in `id` calls this and waits until you click a button on the approval card. */
  private ask(id: string) {
    return (req: ApprovalRequest) =>
      new Promise<Approval>((resolve) => {
        const pending: Pending = { id: this.deps.newId(), req, resolve };
        this.store.update(id, (s) => ({ approvals: [...s.approvals, pending] }));
        const s = this.store.get(id);
        this.deps.notify("Needs your approval", `${s ? titleOf(s) : "A chat"}: ${req.tool}${req.where ? ` in ${req.where}` : ""}`);
      });
  }

  answer(id: string, answer: Approval) {
    const s = this.store.get(id);
    const first = s?.approvals[0];
    if (!s || !first) return;
    this.store.update(id, { approvals: s.approvals.slice(1) });
    first.resolve(answer);
  }

  // ----- queued messages -----

  enqueue(id: string, text: string) {
    this.store.update(id, (s) => ({ queue: [...s.queue, { id: this.deps.newId(), text }] }));
  }

  /** A queued message: join the run at its next step if one is going, otherwise send it now. */
  sendQueued(id: string, queuedId: string) {
    const s = this.store.get(id);
    const item = s?.queue.find((q) => q.id === queuedId);
    if (!s || !item) return;
    if (isBusy(s)) {
      this.store.update(id, { queue: s.queue.map((q) => (q.id === queuedId ? { ...q, steering: true } : q)) });
      return;
    }
    this.store.update(id, { queue: s.queue.filter((q) => q.id !== queuedId) });
    void this.run(id, [...s.messages, { role: "user", content: item.text }]);
  }

  /** Takes a queued message back to change it. Returns its text. */
  takeQueued(id: string, queuedId: string): string | null {
    const s = this.store.get(id);
    const item = s?.queue.find((q) => q.id === queuedId);
    if (!s || !item || item.steering) return null;
    this.store.update(id, { queue: s.queue.filter((q) => q.id !== queuedId) });
    return item.text;
  }

  removeQueued(id: string, queuedId: string) {
    this.store.update(id, (s) => ({ queue: s.queue.filter((q) => q.id !== queuedId) }));
  }

  /** After Stop: throw the queue away, or keep it for you to send yourself. */
  clearQueue(id: string) {
    this.store.update(id, { queue: [] });
  }
  keepQueue(id: string) {
    this.store.update(id, (s) => ({ queue: s.queue.map((q) => ({ ...q, steering: false })) }));
  }

  // ----- starting runs -----

  /** Sends what you typed, or lines it up behind the run in progress. */
  send(id: string, text: string) {
    const s = this.store.get(id);
    const t = text.trim();
    if (!s || !t) return;
    this.store.update(id, { draft: "", ...(isBusy(s) ? {} : { notice: "" }) });
    if (isBusy(s)) this.enqueue(id, t);
    else void this.run(id, [...s.messages, { role: "user", content: t }]);
  }

  /** Picks up where a stopped, cut-off or step-limited run left off. */
  continueRun(id: string) {
    const s = this.store.get(id);
    if (!s || isBusy(s)) return;
    this.store.update(id, { notice: "" });
    const last = s.messages[s.messages.length - 1];
    // If the last thing is your own message, it never got an answer: ask again rather than add another.
    void this.run(id, last?.role === "user" ? s.messages : [...s.messages, { role: "user", content: "Continue." }]);
  }

  /** The agent proposed a plan in Plan mode and you're happy with it. */
  approvePlan(id: string) {
    const s = this.store.get(id);
    if (!s || isBusy(s)) return;
    this.setMode(id, "acceptEdits", true);
    void this.run(id, [...s.messages, { role: "user", content: "The plan is approved. Go ahead and carry it out." }]);
  }

  /** Raises this chat's budget by `dollars` and carries on. */
  addBudgetAndContinue(id: string, dollars: number) {
    const s = this.store.get(id);
    if (!s || isBusy(s)) return;
    const meta = { ...s.meta, budgetExtra: (s.meta.budgetExtra ?? 0) + dollars };
    void this.run(id, [...s.messages, { role: "user", content: "Continue." }], { meta });
  }

  /** From the cost chip: allow this chat to spend more. */
  addBudget(id: string, dollars: number) {
    const s = this.store.get(id);
    if (s) this.updateMeta(id, { budgetExtra: (s.meta.budgetExtra ?? 0) + dollars });
  }

  /** The subagent runs that belong to these messages. */
  private subagentsFor(s: Session, kept: Msg[]) {
    const ids = new Set(kept.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])));
    return Object.fromEntries(Object.entries(s.subagents).filter(([sid]) => ids.has(sid)));
  }

  /** Throws away the last reply and asks again, first undoing its file changes if you chose to. */
  async regenerate(id: string, undoFiles: boolean) {
    const s = this.store.get(id);
    if (!s || isBusy(s)) return;
    const at = s.messages.map((m) => m.role).lastIndexOf("user");
    if (at === -1) return;
    if (undoFiles) await this.undoRuns(id, runsFrom(s.runs, at), false);
    const now = this.store.get(id);
    if (!now || isBusy(now)) return;
    const kept = now.messages.slice(0, at + 1);
    void this.run(id, kept, { subagents: this.subagentsFor(now, kept) });
  }

  /** Replace your message and everything after it in this chat. */
  async editInPlace(id: string, index: number, text: string, undoFiles: boolean) {
    const s = this.store.get(id);
    if (!s || isBusy(s)) return;
    if (undoFiles) await this.undoRuns(id, runsFrom(s.runs, index), false);
    const now = this.store.get(id);
    if (!now || isBusy(now)) return;
    const kept = now.messages.slice(0, index);
    void this.run(id, [...kept, { role: "user", content: text }], { subagents: this.subagentsFor(now, kept) });
  }

  /** A new chat made from these messages. It starts with no cost; that stays with the original. */
  private makeFork(s: Session, kept: Msg[], messageIndex: number): Conversation {
    return {
      id: this.deps.newId(),
      title: `${titleOf(s)} (fork)`.slice(0, 100),
      titleEdited: true,
      updatedAt: this.deps.now(),
      messages: kept,
      projects: s.projects.map((p) => ({ ...p })),
      subagents: this.subagentsFor(s, kept),
      usage: emptyUsage(),
      forkedFrom: { chatId: s.id, messageIndex },
      mode: s.mode,
    };
  }

  /** "Fork from here". Returns the new chat's id, ready to show. */
  async fork(id: string, index: number): Promise<string | null> {
    const ws = this.deps.workspace();
    const s = this.store.get(id);
    if (!ws || !s || isBusy(s)) return null;
    const fork = this.makeFork(s, forkMessages(s.messages, index), index);
    await this.deps.saveChat(ws, fork);
    this.deps.chatsChanged();
    this.ensure(fork);
    return fork.id;
  }

  /** Edit your message in a new chat, leaving this one as it is. Returns the new chat's id, which is now working. */
  async editInFork(id: string, index: number, text: string): Promise<string | null> {
    const ws = this.deps.workspace();
    const s = this.store.get(id);
    if (!ws || !s || isBusy(s)) return null;
    const kept = forkMessages(s.messages, index - 1);
    const fork = this.makeFork(s, kept, index);
    await this.deps.saveChat(ws, fork);
    const created = this.ensure(fork);
    void this.run(created.id, [...kept, { role: "user", content: text }], { subagents: fork.subagents });
    return created.id;
  }

  // ----- undo -----

  async refreshChanged(id: string) {
    const s = this.store.get(id);
    if (!s) return;
    try {
      const status = await this.deps.checkpointStatus(id, s.runs);
      const live = s.runs.filter((r) => (status.find((x) => x.runId === r.run)?.files ?? 0) > 0);
      this.store.update(id, (now) => ({
        changed: changedByTurn(s.runs, status),
        // forget runs that changed nothing, unless a new run was added meanwhile
        ...(live.length !== s.runs.length && now.runs === s.runs ? { runs: live } : {}),
      }));
    } catch {
      // no undo information available: the buttons just don't show
    }
  }

  /** Reverts runs and reports what happened. Files changed since are left alone unless `force`. */
  async undoRuns(id: string, runIds: string[], force: boolean) {
    try {
      const result = await this.deps.revertRuns(id, runIds, force);
      const text = summarizeRevert(result);
      this.setNotice(id, text);
      this.emit(id, { category: "chat", level: result.skipped.length ? "warn" : "info", summary: text });
    } catch (e) {
      this.setError(id, `Undo: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refreshChanged(id);
    this.deps.gitChanged(this.store.get(id)?.projects.map((p) => p.name) ?? []);
  }

  // ----- the run itself -----

  /** Chats other than `id` that are working in any of these projects. */
  private othersWorkingIn(id: string, projects: string[]): { title: string; project: string }[] {
    return this.store
      .all()
      .filter((o) => o.id !== id && o.phase !== "idle")
      .flatMap((o) => o.projects.filter((p) => p.writable && projects.includes(p.name)).map((p) => ({ title: titleOf(o), project: p.name })));
  }

  /** Before the agent's first change to a project in this chat, put the chat on its own branch (if that's switched on). */
  private async prepareBranch(id: string, project: string) {
    const ws = this.deps.workspace();
    const s = this.store.get(id);
    if (!this.deps.branchPerChat() || !ws || !s) return;
    const key = `${id}:${project}`;
    if (this.branched.has(key)) return;
    this.branched.add(key);
    const others = this.othersWorkingIn(id, [project]);
    if (others.length) {
      // Switching branches changes the files under the other agent.
      this.emit(id, { category: "chat", level: "warn", summary: `Didn't make a branch for ${project}: "${others[0].title}" is also working in it, and switching branches would change its files` });
      return;
    }
    const info = await this.deps.gitStatus(ws, project);
    if (!isShowable(info) || info.blocked || isChatBranch(info.branch)) return;
    const name = branchName(titleOf(s), id);
    try {
      await this.deps.gitCreateBranch(ws, project, name);
      this.emit(id, { category: "chat", summary: `Put ${project} on a new branch, ${name}, before the first change` });
      this.setNotice(id, `${project} is now on the branch ${name}.`);
      this.deps.gitChanged([project]);
    } catch (e) {
      this.emit(id, { category: "chat", level: "warn", summary: `Didn't make a branch for ${project}: ${String(e)}` });
      this.setNotice(id, `Didn't make a branch for ${project}: ${String(e)}`);
    }
  }

  /** Runs the agent on `history` and saves the chat as it goes, so closing the app mid-run loses little. */
  async run(id: string, history: Msg[], opts: RunOptions = {}) {
    const ws = this.deps.workspace();
    const apiKey = this.deps.apiKey();
    const start = this.store.get(id);
    if (!ws || !apiKey || !start || isBusy(start)) return;

    const model = this.deps.model();
    const turn = history.map((m) => m.role).lastIndexOf("user"); // costs and undo are kept per turn
    const runId = this.deps.newId();
    const controller = new AbortController();
    const runKey = this.deps.newId();
    this.active.set(id, { abort: controller, runKey });
    this.warned.set(id, { context: new Set(), budget: false });
    this.store.update(id, {
      phase: "waiting", error: "", stopped: false, closedMidRun: false, attention: null, messages: history, streaming: "",
      subagents: opts.subagents ?? start.subagents, runs: [...start.runs, { run: runId, turn }], updatedAt: this.deps.now(),
      ...(opts.meta ? { meta: opts.meta } : {}), ...(opts.usage ? { usage: opts.usage } : {}),
    });
    const fail = (e: unknown) => {
      const text = `Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}`;
      this.setError(id, text);
      this.emit(id, { category: "error", level: "error", summary: text });
    };

    // Your message is saved before the agent starts, so it survives a crash.
    try {
      await this.deps.saveChat(ws, this.snapshot(id)!);
      this.deps.chatsChanged();
    } catch (e) {
      fail(e);
    }

    // Only so many chats work at once; the rest wait here. (Stop pressed while saving counts as stopping while waiting.)
    const got = controller.signal.aborted ? false : await this.acquire(id);
    if (!got) {
      this.active.delete(id);
      this.store.update(id, { phase: "idle", stopped: true });
      await this.saveNow(id).catch(fail);
      return;
    }
    this.store.update(id, { phase: "running" });

    const limits = this.deps.limits();
    const chatCap = effectiveCap(limits.budgetUsd, (opts.meta ?? start.meta).budgetExtra);
    const runRef = `run-${id}-${this.deps.now()}`;
    let failure: string | undefined;
    const writable = start.projects.filter((p) => p.writable).map((p) => p.name);
    const clash = this.othersWorkingIn(id, writable);
    this.emit(id, {
      category: "run", ref: runRef, pending: true, summary: `Run started with ${model}`,
      detail: {
        mode: this.store.get(id)?.mode, messages: history.length,
        projects: start.projects.map((p) => `${p.name}${p.writable ? "" : " (read-only)"}`), ...(chatCap > 0 ? { budget: chatCap } : {}),
      },
    });
    if (clash.length) {
      const text = `"${clash[0].title}" is also working in ${clash[0].project}. Both agents can edit the same files. Undo still works for each, and changes the other makes show up as conflicts.`;
      this.setNotice(id, text);
      this.emit(id, { category: "chat", level: "warn", summary: text });
    }

    let latestProjects = start.projects.map((p) => ({ ...p })); // the loop changes this copy
    try {
      const final = await this.deps.runAgent({
        apiKey, model, workspace: ws,
        projects: latestProjects,
        onProjectsChange: (p) => {
          latestProjects = p;
          this.store.update(id, { projects: p });
        },
        getMode: () => this.store.get(id)?.mode ?? "ask",
        limits, redact: this.deps.redact(),
        runKey,
        checkpoint: { chatId: id, runId },
        beforeWrite: (project) => this.prepareBranch(id, project),
        messages: history,
        ask: this.ask(id),
        signal: controller.signal,
        onUpdate: (msgs, partial) => {
          this.store.update(id, { messages: [...msgs], streaming: partial });
          if (!partial) this.saveSoon(id);
        },
        onSubagent: (callId, sub) => {
          this.store.update(id, (s) => ({ subagents: { ...s.subagents, [callId]: sub } }));
          this.saveSoon(id);
        },
        onUsage: (u) => {
          const price = this.deps.modelInfo(u.model);
          let total!: ChatUsage;
          this.store.update(id, (s) => {
            total = addUsage(s.usage, u, price, turn);
            return { usage: total, ...(u.role === "main" ? { lastUsage: { promptTokens: u.promptTokens, completionTokens: u.completionTokens } } : {}) };
          });
          // Say once when the conversation or the budget is getting full.
          const warned = this.warned.get(id)!;
          const window = this.deps.modelInfo(model)?.contextLength;
          if (u.role === "main" && window) {
            for (const tier of [0.9, 0.7]) {
              if (u.promptTokens / window >= tier && !warned.context.has(tier)) {
                warned.context.add(tier);
                if (tier === 0.9) warned.context.add(0.7);
                this.emit(id, { category: "chat", level: "warn", summary: `The conversation fills ${Math.round((u.promptTokens / window) * 100)}% of the model's context` });
                break;
              }
            }
          }
          if (!warned.budget && budgetState(total.cost, chatCap) === "warn") {
            warned.budget = true;
            this.emit(id, { category: "chat", level: "warn", summary: `This chat has used 80% of its ${formatCost(chatCap)} budget` });
          }
        },
        onEvent: (draft) => this.emit(id, draft),
        overBudget: () => (chatCap > 0 && (this.store.get(id)?.usage.cost ?? 0) >= chatCap ? chatCap : null),
        takeSteering: () => {
          const mine = this.store.get(id)?.queue.filter((q) => q.steering) ?? [];
          if (mine.length === 0) return [];
          this.store.update(id, (s) => ({ queue: s.queue.filter((q) => !q.steering) }));
          return mine.map((q) => q.text);
        },
      });
      this.store.update(id, { messages: final });
    } catch (e) {
      if (!controller.signal.aborted) {
        failure = e instanceof Error ? e.message : String(e);
        this.setError(id, failure);
      }
    } finally {
      const timer = this.saveTimers.get(id);
      if (timer) clearTimeout(timer);
      this.saveTimers.delete(id);
      this.active.delete(id);
      this.release();
      const wasStopped = controller.signal.aborted;
      const watching = this.displayed === id;
      const ending = runState(this.store.get(id)?.messages ?? []);
      // A message sent "now" that the run finished before reading goes back to waiting its turn.
      this.store.update(id, (s) => ({
        streaming: "", phase: "idle", approvals: [], stopped: wasStopped, touched: this.deps.now(), updatedAt: this.deps.now(),
        queue: s.queue.map((q) => (q.steering ? { ...q, steering: false } : q)),
        attention: watching || wasStopped ? null : failure ? "failed" : "done",
      }));
      this.emit(id, {
        category: "run", ref: runRef,
        level: failure ? "error" : wasStopped || ending !== "done" ? "warn" : "info",
        summary: failure ? `Run failed: ${failure}`
          : wasStopped ? "Run stopped by you"
          : ending === "limit" ? "Run stopped at the step limit"
          : ending === "budget" ? "Run stopped at the budget"
          : ending === "done" ? "Run finished" : "Run ended without an answer",
        detail: { messages: this.store.get(id)?.messages.length },
      });
      try {
        await this.saveNow(id);
        await this.refreshChanged(id);
        this.deps.gitChanged(latestProjects.map((p) => p.name));
      } catch (e) {
        fail(e);
      }
      const done = this.store.get(id);
      if (done && !wasStopped) {
        const title = titleOf(done);
        if (failure) this.deps.notify("A chat stopped with an error", `${title}: ${failure}`);
        else if (ending === "done" || ending === "limit") this.deps.notify("A chat finished", title);
      }
      // When a run finishes normally, the next queued message goes out by itself.
      if (done && done.queue.length > 0 && done.approvals.length === 0 && !wasStopped && !failure && (ending === "done" || ending === "limit")) {
        const [next, ...rest] = done.queue;
        this.store.update(id, { queue: rest });
        void this.run(id, [...done.messages, { role: "user", content: next.text }]);
      }
    }
  }
}

export function createController(deps: Partial<Deps> & Pick<Deps, "workspace" | "apiKey" | "model" | "limits">, store = new SessionStore()) {
  const full: Deps = {
    runAgent,
    redact: () => true,
    branchPerChat: () => false,
    defaultMode: () => "ask",
    modelInfo: () => undefined,
    saveChat: async () => {},
    saveActivity: () => {},
    loadActivity: async () => [],
    chatsChanged: () => {},
    gitStatus: async () => ({ hasGit: false, isRepo: false, branch: null, detached: false, changed: 0, untracked: 0, blocked: null }),
    gitCreateBranch: async () => {},
    gitChanged: () => {},
    checkpointStatus: async () => [],
    revertRuns: async () => ({ restored: 0, deleted: 0, skipped: [] }),
    cancelCommands: () => {},
    notify: () => {},
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...deps,
  };
  return new SessionController(store, full);
}
