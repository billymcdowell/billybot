import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  AlertCircleIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  EyeIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  MicIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_MODEL, loadInstructions, runAgent, systemPrompt, toolsFor } from "./agent";
import { textOf } from "./text";
import ChatList from "./ChatList";
import CostChip, { budgetStep } from "./CostChip";
import ContextMeter from "./ContextMeter";
import { contextBreakdown } from "./context";
import { addUsage, effectiveCap, emptyUsage, formatCost, type ChatUsage } from "./cost";
import ExportMenu from "./ExportMenu";
import { chatToJson, chatToMarkdown, exportFileName } from "./exportChat";
import { autoTitle, forkMessages, repairMessages, repairSubagents, runState, type RunState } from "./history";
import { formatInstructions, type ProjectInstructions } from "./instructions";
import DiffView from "./DiffView";
import ModelPicker from "./ModelPicker";
import LimitsPopover from "./LimitsPopover";
import { DEFAULT_LIMITS, resolveLimits, type Limits } from "./limits";
import MultiEditDiff from "./MultiEditDiff";
import ThemeToggle from "./ThemeToggle";
import { fetchToolModels, type ModelInfo } from "./models";
import MessageList, { type EditingMessage } from "./Messages";
import { polish, startRecording, transcribe, type Recording } from "./dictation";
import { MODES, type Approval, type ApprovalRequest } from "./permissions";
import { computerName, isWindows, keyStoreName } from "./platform";
import {
  clearAlwaysAllowed,
  deleteConversation,
  getSetting,
  listChats,
  loadChat,
  saveConversation,
  searchChats,
  setSetting,
  updateChatMeta,
  type ChatSummary,
  type Conversation,
  type Mode,
  type OpenProject,
  type SubagentRun,
} from "./storage";

type Pending = { req: ApprovalRequest; resolve: (answer: Approval) => void };

const newId = (): string => crypto.randomUUID();

/** What the open chat remembers besides its messages. */
type ChatMeta = {
  title?: string;
  titleEdited?: boolean;
  pinned?: boolean;
  budgetExtra?: number;
  forkedFrom?: { chatId: string; messageIndex: number };
};
/** A message typed while the agent was working. `steering` ones join the run at its next step. */
type Queued = { id: string; text: string; steering?: boolean };
// Tools whose effects Regenerate can't take back.
const ACTING_TOOLS = ["write_file", "edit_file", "multi_edit", "run_command", "create_project"];

const STATE_NOTE: Record<RunState, string> = {
  none: "",
  done: "",
  stopped: "Stopped.",
  limit: "The agent used up its steps before finishing.",
  budget: "This chat reached its budget.",
  unfinished: "This run didn't finish.",
};
const baseName = (p: string) => p.split(isWindows ? /[\\/]/ : "/").filter(Boolean).pop() ?? p;

/** A centred card, used for the key and workspace screens. */
function Setup(props: { title: string; description: string; error: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {props.children}
          {props.error && <p className="text-sm text-destructive">{props.error}</p>}
        </CardContent>
        <CardFooter>{props.action}</CardFooter>
      </Card>
    </div>
  );
}

type RunOptions = {
  id?: string; // the chat to save into; defaults to the open one
  meta?: ChatMeta;
  subagents?: Record<string, SubagentRun>;
  usage?: ChatUsage;
};

/** Everything a saved chat holds. */
function buildConversation(p: {
  id: string;
  meta: ChatMeta;
  messages: ChatCompletionMessageParam[];
  projects: OpenProject[];
  subagents: Record<string, SubagentRun>;
  usage: ChatUsage;
  stopped: boolean;
}): Conversation {
  return {
    id: p.id,
    title: p.meta.titleEdited && p.meta.title ? p.meta.title : autoTitle(p.messages),
    titleEdited: p.meta.titleEdited,
    pinned: p.meta.pinned,
    updatedAt: Date.now(),
    messages: p.messages,
    projects: p.projects,
    subagents: p.subagents,
    stopped: p.stopped,
    usage: p.usage,
    budgetExtra: p.meta.budgetExtra,
    forkedFrom: p.meta.forkedFrom,
  };
}

/** True if the agent changed files or ran commands in these messages. */
const actedIn = (msgs: ChatCompletionMessageParam[]) =>
  msgs.some(
    (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.type === "function" && ACTING_TOOLS.includes(c.function.name)),
  );

export default function App() {
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined); // undefined = loading
  const [keyInput, setKeyInput] = useState("");
  const [workspace, setWorkspace] = useState<string | null | undefined>(undefined);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mode, setMode] = useState<Mode>("ask");
  const modeRef = useRef<Mode>("ask");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState(newId);
  // What the open chat remembers besides its messages: a name the user chose, and whether it is pinned.
  const [chatMeta, setChatMeta] = useState<ChatMeta>({});
  const [usage, setUsage] = useState<ChatUsage>(emptyUsage());
  const usageRef = useRef<ChatUsage>(emptyUsage()); // read by the running agent, which outlives any one render
  const modelsRef = useRef<ModelInfo[]>([]); // for prices, when OpenRouter doesn't report a cost
  const [queue, setQueue] = useState<Queued[]>([]); // messages typed while the agent was working
  const queueRef = useRef<Queued[]>([]);
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  const [editChoice, setEditChoice] = useState<EditingMessage | null>(null); // asks: fork or replace?
  const [closedMidRun, setClosedMidRun] = useState(false); // the open chat was cut off by the app closing
  const [fullOutput, setFullOutput] = useState(false); // exports: keep whole tool results
  const [notice, setNotice] = useState("");
  const [stopped, setStopped] = useState(false); // the last run ended because Stop was pressed
  const [messages, setMessages] = useState<ChatCompletionMessageParam[]>([]);
  const [projects, setProjects] = useState<OpenProject[]>([]);
  const [subagents, setSubagents] = useState<Record<string, SubagentRun>>({});
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<Pending[]>([]); // a queue: subagents may ask at once
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [dictation, setDictation] = useState<"idle" | "recording" | "working">("idle");
  const [polishOn, setPolishOn] = useState(true);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const recordingRef = useRef<Promise<Recording> | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [instructions, setInstructions] = useState<ProjectInstructions[]>([]); // CLAUDE.md of the open projects
  const state = runState(messages, stopped);
  const cap = effectiveCap(limits.budgetUsd, chatMeta.budgetExtra); // this chat's spending limit; 0 = none

  // Look for a CLAUDE.md in each open project, so you can see which ones the agent is following.
  useEffect(() => {
    if (!workspace) return;
    let current = true;
    loadInstructions(workspace, projects).then((list) => current && setInstructions(list));
    return () => {
      current = false;
    };
  }, [workspace, projects]);
  const [lastUsage, setLastUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);

  // The selected model's context size comes from OpenRouter's model list (fetched once and cached).
  useEffect(() => {
    if (!apiKey) return;
    let current = true;
    fetchToolModels(apiKey)
      .then((list) => {
        modelsRef.current = list;
        if (current) setContextWindow(list.find((m) => m.id === model)?.contextLength ?? null);
      })
      .catch(() => current && setContextWindow(null));
    return () => {
      current = false;
    };
  }, [apiKey, model]);

  // What fills the context: estimated from the conversation, system prompt and tool definitions.
  const breakdown = useMemo(
    () =>
      contextBreakdown({
        systemText: systemPrompt({ role: "main", projects, workspace: workspace ?? "" }),
        toolsText: JSON.stringify(toolsFor("main")),
        instructionsText: formatInstructions(instructions),
        messages,
        streaming,
        window: contextWindow,
      }),
    [projects, workspace, instructions, messages, streaming, contextWindow],
  );

  // On startup: read the key from the system credential store and restore settings.
  useEffect(() => {
    invoke<string | null>("get_api_key")
      .then(setApiKey)
      .catch((e) => {
        setError(String(e));
        setApiKey(null);
      });
    getSetting<string | null>("workspace", null).then(setWorkspace);
    getSetting("model", DEFAULT_MODEL).then(setModel);
    getSetting<Mode>("mode", "ask").then(changeMode);
    getSetting("polish", true).then(setPolishOn);
    getSetting<Partial<Limits>>("limits", {}).then((l) => setLimits(resolveLimits(l)));
  }, []);

  // Load this workspace's chats.
  useEffect(() => {
    if (workspace) listChats(workspace).then(setChats);
  }, [workspace]);

  // Hold Command + Option together anywhere in the window to dictate; let go of either to stop.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && !e.repeat) startDictation();
    };
    const up = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.altKey)) stopDictation();
    };
    // If the window loses focus while the keys are down, no key-up arrives, so stop here
    // or the microphone would stay on.
    const blur = () => stopDictation();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  });

  function changeMode(m: Mode) {
    modeRef.current = m;
    setMode(m);
    setSetting("mode", m);
  }

  async function saveKey() {
    try {
      await invoke("set_api_key", { key: keyInput });
      setApiKey(keyInput.trim());
      setKeyInput("");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function pickWorkspace() {
    const picked = await open({ directory: true, title: "Choose your workspace folder" });
    if (typeof picked !== "string") return;
    try {
      const ws = await invoke<string>("check_workspace", { path: picked });
      setWorkspace(ws);
      setSetting("workspace", ws);
      setError("");
      newChat();
    } catch (e) {
      setError(String(e));
    }
  }

  function setUsageBoth(u: ChatUsage) {
    usageRef.current = u;
    setUsage(u);
  }

  function updateQueue(change: (q: Queued[]) => Queued[]) {
    queueRef.current = change(queueRef.current);
    setQueue(queueRef.current);
  }

  function newChat() {
    setChatId(newId());
    setChatMeta({});
    setStopped(false);
    setClosedMidRun(false);
    setMessages([]);
    setProjects([]);
    setSubagents({});
    setUsageBoth(emptyUsage());
    setLastUsage(null);
    setEditing(null);
    updateQueue(() => []);
    setError("");
  }

  /** Puts a chat on screen. */
  function showChat(c: Conversation) {
    // A chat cut off by closing the app can have tool calls with no results, which the API refuses.
    const fixed = repairMessages(c.messages);
    const subs = repairSubagents(c.subagents);
    setChatId(c.id);
    setChatMeta({ title: c.title, titleEdited: c.titleEdited, pinned: c.pinned, budgetExtra: c.budgetExtra, forkedFrom: c.forkedFrom });
    setStopped(c.stopped === true);
    setClosedMidRun(fixed.repaired || subs.repaired);
    setMessages(fixed.messages);
    setProjects(c.projects);
    setSubagents(subs.subagents);
    setUsageBoth(c.usage ?? emptyUsage());
    setLastUsage(null);
    setEditing(null);
    updateQueue(() => []);
    setError("");
  }

  async function openChat(id: string) {
    if (!workspace) return;
    const c = await loadChat(workspace, id);
    if (!c) {
      setError("That chat couldn't be opened. It may have been deleted or damaged.");
      setChats(await listChats(workspace));
      return;
    }
    showChat(c);
  }

  async function removeChat(id: string) {
    if (!workspace) return;
    await deleteConversation(workspace, id);
    setChats(await listChats(workspace));
    if (id === chatId) newChat();
  }

  async function renameChat(id: string, title: string) {
    if (!workspace) return;
    await updateChatMeta(workspace, id, { title });
    if (id === chatId) setChatMeta((m) => ({ ...m, title: title.trim(), titleEdited: true }));
    setChats(await listChats(workspace));
  }

  async function pinChat(id: string, pinned: boolean) {
    if (!workspace) return;
    await updateChatMeta(workspace, id, { pinned });
    if (id === chatId) setChatMeta((m) => ({ ...m, pinned }));
    setChats(await listChats(workspace));
  }

  // You can close a project or flip it between read-only and writable yourself.
  function toggleWritable(name: string) {
    setProjects((ps) => ps.map((p) => (p.name === name ? { ...p, writable: !p.writable } : p)));
  }
  function closeProject(name: string) {
    setProjects((ps) => ps.filter((p) => p.name !== name));
  }

  async function resetAlwaysAllow() {
    if (!workspace) return;
    await clearAlwaysAllowed(workspace);
    for (const p of projects) await clearAlwaysAllowed(`${workspace}/${p.name}`);
  }

  // Agents call this and wait until you click a button on the approval card.
  function ask(req: ApprovalRequest) {
    return new Promise<Approval>((resolve) => setApprovals((q) => [...q, { req, resolve }]));
  }

  function answer(a: Approval) {
    approvals[0]?.resolve(a);
    setApprovals((q) => q.slice(1));
  }

  async function stop() {
    abortRef.current?.abort();
    invoke("cancel_commands").catch(() => {}); // kills any command that is running right now
    approvals.forEach((p) => p.resolve("deny")); // unblocks anything waiting on you
    setApprovals([]);
    // Queued messages were meant for a run that is over. Ask before throwing away more than one.
    const waiting = queueRef.current.length;
    if (waiting === 0) return;
    const clear =
      waiting === 1 ||
      (await confirm(`Also discard the ${waiting} messages waiting in the queue?`, { title: "Stop", okLabel: "Discard", cancelLabel: "Keep them" }));
    if (clear) updateQueue(() => []);
    else updateQueue((q) => q.map((x) => ({ ...x, steering: false })));
  }

  /** Sends what you typed, or lines it up behind the run in progress. */
  function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (busy) {
      updateQueue((q) => [...q, { id: newId(), text }]);
      return;
    }
    run([...messages, { role: "user", content: text }]);
  }

  /** A queued message: join the run at its next step if one is going, otherwise send it now. */
  function sendQueued(id: string) {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item) return;
    if (busy) {
      updateQueue((q) => q.map((x) => (x.id === id ? { ...x, steering: true } : x)));
      return;
    }
    updateQueue((q) => q.filter((x) => x.id !== id));
    run([...messages, { role: "user", content: item.text }]);
  }

  /** Takes a queued message back into the box to change it. */
  function editQueued(id: string) {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item || item.steering) return;
    updateQueue((q) => q.filter((x) => x.id !== id));
    setInput(item.text);
  }

  // When a run finishes normally, the next queued message goes out by itself.
  useEffect(() => {
    if (busy || approvals.length > 0 || queue.length === 0) return;
    if (state !== "done" && state !== "limit") return;
    const [next] = queue;
    updateQueue((q) => q.slice(1));
    run([...messages, { role: "user", content: next.text }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue, state]);

  /** Picks up where a stopped, cut-off or step-limited run left off. */
  function continueRun() {
    if (busy) return;
    const last = messages[messages.length - 1];
    // If the last thing is your own message, it never got an answer: ask again rather than add another.
    run(last?.role === "user" ? messages : [...messages, { role: "user", content: "Continue." }]);
  }

  /** Raises this chat's budget and carries on. */
  function addBudgetAndContinue() {
    if (busy) return;
    const meta = { ...chatMeta, budgetExtra: (chatMeta.budgetExtra ?? 0) + budgetStep(cap) };
    run([...messages, { role: "user", content: "Continue." }], { meta });
  }

  /** From the cost chip: allow this chat to spend more. */
  async function addBudget(dollars: number) {
    if (!workspace) return;
    const budgetExtra = (chatMeta.budgetExtra ?? 0) + dollars;
    setChatMeta((m) => ({ ...m, budgetExtra }));
    if (messages.length > 0) await updateChatMeta(workspace, chatId, { budgetExtra }).catch(() => {});
  }

  /** Throws away the last reply and asks again. */
  async function regenerate() {
    if (busy) return;
    const at = messages.map((m) => m.role).lastIndexOf("user");
    if (at === -1) return;
    const dropped = messages.slice(at + 1);
    if (actedIn(dropped)) {
      const go = await confirm(
        "Regenerating starts this reply over, but it won't undo changes already made to files or commands already run.",
        { title: "Regenerate?", kind: "warning", okLabel: "Regenerate" },
      );
      if (!go) return;
    }
    const kept = messages.slice(0, at + 1);
    run(kept, { subagents: subagentsFor(kept) });
  }

  /** The subagent runs that belong to these messages. */
  function subagentsFor(kept: ChatCompletionMessageParam[]) {
    const ids = new Set(kept.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])));
    return Object.fromEntries(Object.entries(subagents).filter(([id]) => ids.has(id)));
  }

  /** A new chat made from these messages of the open one. It starts with no cost; that stays with the original. */
  function makeFork(kept: ChatCompletionMessageParam[], messageIndex: number): Conversation {
    const base = chatMeta.titleEdited && chatMeta.title ? chatMeta.title : autoTitle(messages);
    return {
      id: newId(),
      title: `${base} (fork)`.slice(0, 100),
      titleEdited: true,
      updatedAt: Date.now(),
      messages: kept,
      projects: projects.map((p) => ({ ...p })),
      subagents: subagentsFor(kept),
      usage: emptyUsage(),
      forkedFrom: { chatId, messageIndex },
    };
  }

  async function forkChat(index: number) {
    if (!workspace || busy) return;
    const fork = makeFork(forkMessages(messages, index), index);
    await saveConversation(workspace, fork);
    setChats(await listChats(workspace));
    showChat(fork);
  }

  // Editing one of your messages: you choose whether to branch off or replace what came after.
  function submitEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text || text === textOf(messages[editing.index]?.content).trim()) {
      setEditing(null);
      return;
    }
    setEditChoice({ index: editing.index, text });
  }

  async function editInFork() {
    const choice = editChoice;
    setEditChoice(null);
    if (!choice || !workspace || busy) return;
    const kept = forkMessages(messages, choice.index - 1);
    const fork = makeFork(kept, choice.index);
    await saveConversation(workspace, fork);
    showChat(fork);
    run([...kept, { role: "user", content: choice.text }], {
      id: fork.id,
      meta: { title: fork.title, titleEdited: true, forkedFrom: fork.forkedFrom },
      subagents: fork.subagents,
      usage: emptyUsage(),
    });
  }

  function editInPlace() {
    const choice = editChoice;
    setEditChoice(null);
    if (!choice || busy) return;
    const kept = messages.slice(0, choice.index);
    run([...kept, { role: "user", content: choice.text }], { subagents: subagentsFor(kept) });
  }

  async function exportChat(format: "md" | "json") {
    if (messages.length === 0) return;
    const convo = buildConversation({ id: chatId, meta: chatMeta, messages, projects, subagents, usage, stopped });
    const options = { fullToolOutput: fullOutput };
    const text = format === "md" ? chatToMarkdown(convo, options) : chatToJson(convo, options);
    try {
      const path = await save({
        defaultPath: exportFileName(convo.title, format),
        filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
      });
      if (!path) return;
      await invoke("write_export", { path, contents: text });
      setNotice(`Saved ${baseName(path)}. Secrets were redacted.`);
    } catch (e) {
      setError(`Export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Runs the agent on `history` and saves the chat as it goes, so closing the app mid-run loses little. */
  async function run(history: ChatCompletionMessageParam[], opts: RunOptions = {}) {
    if (!workspace || !apiKey || busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    setStopped(false);
    setClosedMidRun(false);
    setEditing(null);
    setMessages(history);
    if (opts.meta) setChatMeta(opts.meta);
    if (opts.usage) setUsageBoth(opts.usage);
    const controller = new AbortController();
    abortRef.current = controller;
    let latest = history;
    let latestProjects = projects.map((p) => ({ ...p })); // the loop changes this copy
    let subs = { ...(opts.subagents ?? subagents) };
    const id = opts.id ?? chatId;
    const meta = opts.meta ?? chatMeta;
    const turn = history.map((m) => m.role).lastIndexOf("user"); // costs are totalled per turn
    const chatCap = effectiveCap(limits.budgetUsd, meta.budgetExtra);

    const snapshot = (wasStopped = false) =>
      buildConversation({ id, meta, messages: latest, projects: latestProjects, subagents: subs, usage: usageRef.current, stopped: wasStopped });
    // Save at most every couple of seconds while the agent works (not on every streamed word).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saveSoon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        saveConversation(workspace, snapshot()).catch(() => {});
      }, 2000);
    };

    // Your message is saved before the agent starts, so it survives a crash.
    try {
      await saveConversation(workspace, snapshot());
      setChats(await listChats(workspace));
    } catch (e) {
      setError(`Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      latest = await runAgent({
        apiKey,
        model,
        workspace,
        projects: latestProjects,
        onProjectsChange: (p) => {
          latestProjects = p;
          setProjects(p);
        },
        getMode: () => modeRef.current,
        limits,
        messages: history,
        ask,
        signal: controller.signal,
        onUpdate: (msgs, partial) => {
          latest = msgs;
          setMessages([...msgs]);
          setStreaming(partial);
          if (!partial) saveSoon();
        },
        onSubagent: (callId, sub) => {
          subs = { ...subs, [callId]: sub };
          setSubagents(subs);
          saveSoon();
        },
        onUsage: (u) => {
          if (u.role === "main") setLastUsage({ promptTokens: u.promptTokens, completionTokens: u.completionTokens });
          const price = modelsRef.current.find((m) => m.id === u.model);
          setUsageBoth(addUsage(usageRef.current, u, price, turn));
        },
        overBudget: () => (chatCap > 0 && usageRef.current.cost >= chatCap ? chatCap : null),
        takeSteering: () => {
          const mine = queueRef.current.filter((q) => q.steering);
          if (mine.length === 0) return [];
          updateQueue((q) => q.filter((x) => !x.steering));
          return mine.map((q) => q.text);
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
      // A message sent "now" that the run finished before reading goes back to waiting its turn.
      updateQueue((q) => q.map((x) => (x.steering ? { ...x, steering: false } : x)));
      setStreaming("");
      setBusy(false);
      setApprovals([]);
      setMessages(latest);
      const wasStopped = controller.signal.aborted;
      setStopped(wasStopped);
      try {
        await saveConversation(workspace, snapshot(wasStopped));
        setChats(await listChats(workspace));
      } catch (e) {
        setError(`Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  function startDictation() {
    if (!apiKey || !workspace || recordingRef.current) return;
    setError("");
    const pending = startRecording();
    recordingRef.current = pending;
    setDictation("recording");
    pending.catch((e) => {
      recordingRef.current = null;
      setDictation("idle");
      setError(`Microphone: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async function stopDictation() {
    const pending = recordingRef.current;
    if (!pending || !apiKey) return;
    recordingRef.current = null;
    setDictation("working");
    try {
      const recording = await pending;
      const audio = await recording.stop();
      if (Date.now() - recording.startedAt < 400) return; // a quick tap, not speech
      let text = await transcribe(audio);
      if (text && polishOn) text = await polish(apiKey, text).catch(() => text);
      if (text) setInput((prev) => (prev.trim() ? prev.trimEnd() + " " : "") + text);
    } catch (e) {
      setError(`Dictation: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDictation("idle");
    }
  }

  // ---------- Screens ----------

  if (apiKey === undefined || workspace === undefined) {
    return (
      <div className="flex h-svh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (apiKey === null) {
    return (
      <Setup
        title="Add your OpenRouter key"
        description={`It's saved in ${keyStoreName}, never in a file.`}
        error={error}
        action={
          <Button className="w-full" onClick={saveKey} disabled={!keyInput.trim()}>
            Save key
          </Button>
        }
      >
        <Input type="password" placeholder="sk-or-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
      </Setup>
    );
  }

  if (workspace === null) {
    return (
      <Setup
        title="Choose your workspace"
        description="Pick the folder that holds your projects, such as ~/Projects. The agent can work in any folder inside it, and nothing outside it."
        error={error}
        action={
          <Button className="w-full" onClick={pickWorkspace}>
            <FolderIcon />
            Choose folder…
          </Button>
        }
      >
        {null}
      </Setup>
    );
  }

  const pending = approvals[0];

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={pickWorkspace} disabled={busy} tooltip={workspace}>
                  <FolderIcon />
                  <span>{baseName(workspace)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={newChat} disabled={busy}>
                  <PlusIcon />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <ChatList
              chats={chats}
              activeId={chatId}
              busy={busy}
              onOpen={openChat}
              onDelete={removeChat}
              onRename={renameChat}
              onPin={pinChat}
              onSearch={(q) => searchChats(workspace, q)}
            />
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="sm" onClick={resetAlwaysAllow}>
                  <RotateCcwIcon />
                  <span>Reset "always allow"</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex h-svh flex-col">
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            {/* Open projects: click to flip read-only/writable, × to close */}
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {projects.length === 0 && (
                <span className="text-sm text-muted-foreground">No project open. The agent will pick or create one.</span>
              )}
              {projects.map((p) => (
                <ButtonGroup key={p.name}>
                  <Button
                    size="xs"
                    variant={p.writable ? "default" : "outline"}
                    onClick={() => toggleWritable(p.name)}
                    disabled={busy}
                    title={
                      instructions.some((i) => i.project === p.name)
                        ? "Switch between read-only and writable. Its CLAUDE.md is part of the agent's instructions."
                        : "Switch between read-only and writable"
                    }
                  >
                    {p.writable ? <PencilIcon /> : <EyeIcon />}
                    {p.name}
                    {instructions.some((i) => i.project === p.name) && <FileTextIcon aria-label="Has CLAUDE.md" />}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="outline"
                    onClick={() => closeProject(p.name)}
                    disabled={busy}
                    aria-label={`Close ${p.name}`}
                  >
                    <XIcon />
                  </Button>
                </ButtonGroup>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="polish"
                checked={polishOn}
                onCheckedChange={(on) => {
                  setPolishOn(on);
                  setSetting("polish", on);
                }}
              />
              <Label htmlFor="polish">Polish dictation</Label>
              <CostChip usage={usage} cap={cap} onAddBudget={addBudget} disabled={busy} />
              <ExportMenu
                disabled={messages.length === 0}
                fullOutput={fullOutput}
                onFullOutputChange={setFullOutput}
                onExport={exportChat}
              />
              <LimitsPopover
                limits={limits}
                onChange={(l) => {
                  setLimits(l);
                  setSetting("limits", l);
                }}
              />
              <ThemeToggle />
            </div>
          </header>

          <div className="min-h-0 flex-1">
            {messages.length === 0 && !streaming ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyTitle>What are we working on?</EmptyTitle>
                  <EmptyDescription>
                    Describe a task. The agent finds or creates the right project in {baseName(workspace)}.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <MessageList
                messages={messages}
                streaming={streaming}
                subagents={subagents}
                turnCosts={usage.turns}
                busy={busy}
                onFork={forkChat}
                onEdit={(index) => setEditing({ index, text: textOf(messages[index]?.content) })}
                editing={editing}
                onEditChange={(text) => setEditing((e) => (e ? { ...e, text } : e))}
                onEditCancel={() => setEditing(null)}
                onEditSubmit={submitEdit}
              />
            )}
          </div>

          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
            {!busy && state !== "none" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="flex-1">
                  {state === "unfinished" && closedMidRun
                    ? "The app closed while this was running."
                    : state === "unfinished" && messages[messages.length - 1]?.role === "user"
                      ? "That message didn't get an answer."
                      : state === "budget" && cap > 0
                        ? `This chat reached its ${formatCost(cap)} budget.`
                        : STATE_NOTE[state]}
                </span>
                {state === "budget" && cap > 0 ? (
                  <Button size="sm" variant="outline" onClick={addBudgetAndContinue}>
                    <PlayIcon />
                    Add {formatCost(budgetStep(cap))} and continue
                  </Button>
                ) : (
                  state !== "done" && (
                    <Button size="sm" variant="outline" onClick={continueRun}>
                      <PlayIcon />
                      {messages[messages.length - 1]?.role === "user" ? "Retry" : "Continue"}
                    </Button>
                  )
                )}
                <Button size="sm" variant="ghost" onClick={regenerate} title="Throw away the last reply and ask again">
                  <RefreshCwIcon />
                  Regenerate
                </Button>
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {notice && (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}

            {queue.length > 0 && (
              <div className="flex flex-col gap-1" aria-label="Queued messages">
                {queue.map((q) => (
                  <div key={q.id} className="flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-sm">
                    <span className="flex-1 truncate" title={q.text}>
                      {q.text}
                    </span>
                    {q.steering ? (
                      <span className="px-2 text-xs text-muted-foreground">Sending at the next step…</span>
                    ) : (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => sendQueued(q.id)}
                          title={busy ? "Add this to the run at its next step" : "Send this now"}
                        >
                          {busy ? "Send now" : "Send"}
                        </Button>
                        <Button size="icon-xs" variant="ghost" onClick={() => editQueued(q.id)} aria-label="Edit queued message">
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => updateQueue((list) => list.filter((x) => x.id !== q.id))}
                          aria-label="Remove queued message"
                        >
                          <XIcon />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* The Confirmation pattern: approve or deny before a change runs */}
            {pending && (
              <Item variant="outline" size="sm">
                <ItemMedia variant="icon">
                  {pending.req.tool === "create_project" ? (
                    <FolderPlusIcon />
                  ) : pending.req.tool === "run_command" ? (
                    <TerminalIcon />
                  ) : (
                    <FilePenIcon />
                  )}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {pending.req.tool === "create_project"
                      ? `Create project ${String(pending.req.args.name)}?`
                      : pending.req.tool === "run_command"
                        ? `Run a command in ${pending.req.where}?`
                        : pending.req.tool === "edit_file"
                          ? `Edit ${String(pending.req.args.path)}?`
                          : pending.req.tool === "multi_edit"
                            ? `Make ${Array.isArray(pending.req.args.edits) ? pending.req.args.edits.length : "several"} edits to ${String(pending.req.args.path)}?`
                            : `Write ${String(pending.req.args.path)}?`}
                  </ItemTitle>
                  <ItemDescription>
                    {pending.req.who} · {pending.req.where}
                    {approvals.length > 1 && ` · ${approvals.length - 1} more waiting`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="outline" onClick={() => answer("deny")}>
                    Deny
                  </Button>
                  {/* Commands are never remembered: one "always" would approve every future command. */}
                  {pending.req.tool !== "run_command" && (
                    <Button size="sm" variant="outline" onClick={() => answer("always")}>
                      {pending.req.where === "workspace" ? "Always allow creating" : `Always in ${pending.req.where}`}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => answer("once")}>
                    Approve
                  </Button>
                </ItemActions>
                {pending.req.tool === "write_file" && (
                  <ItemFooter>
                    <DiffView
                      before={pending.req.before ?? ""}
                      after={String(pending.req.args.content ?? "")}
                      isNew={pending.req.before === null}
                    />
                  </ItemFooter>
                )}
                {pending.req.tool === "run_command" && (
                  <ItemFooter className="flex-col items-stretch gap-2">
                    <CodeBlock size="sm">
                      <CodeBlockContent wrap className="max-h-48">
                        {String(pending.req.args.command ?? "")}
                      </CodeBlockContent>
                    </CodeBlock>
                    <p className="text-xs text-muted-foreground">
                      Runs on your {computerName} as you, starting in {pending.req.where}. The folder lock does not apply to commands:
                      they can reach any file your account can.
                    </p>
                  </ItemFooter>
                )}
                {pending.req.tool === "multi_edit" && (
                  <ItemFooter>
                    <MultiEditDiff before={pending.req.before} rawEdits={pending.req.args.edits} />
                  </ItemFooter>
                )}
                {pending.req.tool === "edit_file" && (
                  <ItemFooter>
                    <DiffView
                      before={String(pending.req.args.old_text ?? "")}
                      after={String(pending.req.args.new_text ?? "")}
                    />
                  </ItemFooter>
                )}
              </Item>
            )}

            {/* The Prompt Input pattern, with the Model Selector menus beside the send button */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <InputGroup>
                <InputGroupTextarea
                  value={input}
                  placeholder={
                    busy ? "Type to queue a message… (Enter to queue)" : "Ask something… (Enter to send, hold ⌘ ⌥ to dictate)"
                  }
                  className="p-3"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <InputGroupAddon align="block-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <InputGroupButton size="sm">
                        {MODES.find((m) => m.id === mode)?.label}
                        <ChevronDownIcon />
                      </InputGroupButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuRadioGroup value={mode} onValueChange={(v) => changeMode(v as Mode)}>
                        {MODES.map((m) => (
                          <DropdownMenuRadioItem key={m.id} value={m.id}>
                            {m.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <ModelPicker
                    apiKey={apiKey}
                    value={model}
                    disabled={busy}
                    onChange={(id) => {
                      setModel(id);
                      setSetting("model", id);
                    }}
                  />
                  <ContextMeter breakdown={breakdown} lastRequest={lastUsage} />
                  <InputGroupButton
                    size="icon-sm"
                    variant={dictation === "recording" ? "destructive" : "ghost"}
                    className="ml-auto"
                    onClick={() => (dictation === "recording" ? stopDictation() : startDictation())}
                    disabled={dictation === "working"}
                    aria-label="Dictate (or hold ⌘ ⌥)"
                  >
                    {dictation === "working" ? <Spinner /> : dictation === "recording" ? <SquareIcon /> : <MicIcon />}
                  </InputGroupButton>
                  {busy ? (
                    <InputGroupButton
                      size="icon-sm"
                      variant="default"
                      className="rounded-full"
                      onClick={stop}
                      aria-label="Stop"
                    >
                      <SquareIcon />
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      className="rounded-full"
                      disabled={!input.trim()}
                      aria-label="Send"
                    >
                      <ArrowUpIcon />
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
            </form>
          </div>
        </SidebarInset>
      </SidebarProvider>

      <AlertDialog open={editChoice !== null} onOpenChange={(open) => !open && setEditChoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resend this message?</AlertDialogTitle>
            <AlertDialogDescription>
              Editing a message restarts the conversation from that point. Branch off to keep this chat as it is, or replace
              everything after the message in this chat.
              {editChoice && actedIn(messages.slice(editChoice.index + 1)) &&
                " Replacing won't undo changes the agent already made to files or commands it already ran."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" onClick={editInPlace}>
              Replace in this chat
            </Button>
            <Button onClick={editInFork}>Edit in a new chat</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
