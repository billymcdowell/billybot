import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  AlertCircleIcon,
  ActivityIcon,
  ArrowUpIcon,
  GitBranchIcon,
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
  ShieldCheckIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
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
import ActivityPanel, { MAX_WIDTH, MIN_WIDTH } from "./ActivityPanel";
import { makeEvent, mergeEvents, upsertEvent, type ActivityDraft, type ActivityEvent } from "./activity";
import { flushActivity, loadChatActivity, saveActivity } from "./auditLog";
import ChangesDialog from "./ChangesDialog";
import ChatList from "./ChatList";
import {
  changedByTurn, checkpointStatus, describePlan, filesFrom, previewRevert, revertRuns, runsFrom, summarizeRevert,
  type CheckpointRun, type PlanSummary,
} from "./checkpoints";
import CostChip, { budgetStep } from "./CostChip";
import ContextMeter from "./ContextMeter";
import { contextBreakdown } from "./context";
import { addUsage, budgetState, effectiveCap, emptyUsage, formatCost, type ChatUsage } from "./cost";
import ExportMenu from "./ExportMenu";
import { chatToJson, chatToMarkdown, exportFileName } from "./exportChat";
import { branchName, describeGit, gitCreateBranch, gitStatus, isChatBranch, isShowable, type GitInfo } from "./git";
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
import { MODES, nextMode, type Approval, type ApprovalRequest } from "./permissions";
import PermissionsDialog from "./PermissionsDialog";
import { computerName, isWindows, keyStoreName } from "./platform";
import {
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
  checkpoints: CheckpointRun[];
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
    checkpoints: p.checkpoints,
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
  const chatIdRef = useRef(chatId); // the chat on screen, for code that outlives a render
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
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  // Runs that may have changed files (Rust keeps undo copies of them), and how many files each turn changed.
  const [checkpointRuns, setCheckpointRuns] = useState<CheckpointRun[]>([]);
  const checkpointRunsRef = useRef<CheckpointRun[]>([]);
  const [changed, setChanged] = useState<Record<string, number>>({});
  const [revertPlan, setRevertPlan] = useState<{ runIds: string[]; summary: PlanSummary } | null>(null);
  const [regenChoice, setRegenChoice] = useState<number | null>(null); // index of the message being answered again
  const [undoDiscarded, setUndoDiscarded] = useState(true); // the checkbox on the regenerate and edit dialogs
  const [limitsReady, setLimitsReady] = useState(false);
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo>>({}); // by project name
  const [changesFor, setChangesFor] = useState<string | null>(null); // the project whose Changes dialog is open
  const [branchPerChat, setBranchPerChat] = useState(false); // put each chat's changes on their own git branch
  const branchedRef = useRef(new Set<string>()); // "chat:project" pairs already handled this session
  const [events, setEvents] = useState<ActivityEvent[]>([]); // the activity log for the chat on screen
  const eventsRef = useRef<ActivityEvent[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityWidth, setActivityWidth] = useState(420);
  const warnedRef = useRef({ context: new Set<number>(), budget: false }); // each warning is logged once per chat
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
  const [redactOn, setRedactOn] = useState(true); // hide secrets from the model
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
    getSetting<Partial<Limits>>("limits", {}).then((l) => {
      setLimits(resolveLimits(l));
      setLimitsReady(true);
    });
    getSetting("redact", true).then(setRedactOn);
    getSetting("gitBranchPerChat", false).then(setBranchPerChat);
    getSetting("activityOpen", false).then(setActivityOpen);
    getSetting("activityWidth", 420).then((w) => setActivityWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))));
  }, []);

  // Show each open project's branch. Looked at again when projects change, when a run ends, and when you come back to the window.
  const projectKey = projects.map((p) => p.name).join("\n");
  useEffect(() => {
    void refreshGit();
    const onFocus = () => void refreshGit();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, projectKey]);

  // Clear out old undo copies once the limits are known.
  useEffect(() => {
    if (!workspace || !limitsReady) return;
    invoke("checkpoint_prune", { maxAgeDays: limits.checkpointDays, maxMegabytes: limits.checkpointMb }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, limitsReady]);

  // Write any activity still waiting to be saved when the window closes (best effort).
  useEffect(() => {
    const flush = () => void flushActivity();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
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

  function changeMode(m: Mode, byUser = false) {
    modeRef.current = m;
    setMode(m);
    setSetting("mode", m);
    if (byUser) emitEvent({ category: "chat", summary: `Mode changed to ${MODES.find((x) => x.id === m)?.label ?? m}` }, chatIdRef.current);
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

  /** Adds an event to the log for `forChat`: shown if that chat is on screen, and saved to the audit log. */
  function emitEvent(draft: ActivityDraft, forChat: string) {
    const event = makeEvent(draft, forChat);
    if (forChat === chatIdRef.current) {
      eventsRef.current = upsertEvent(eventsRef.current, event);
      setEvents(eventsRef.current);
    }
    if (!event.pending) {
      // Save the merged row (a finished event keeps the id and start time of the running one it replaced).
      const merged = event.ref ? eventsRef.current.find((e) => e.ref === event.ref && e.chatId === forChat) : undefined;
      saveActivity(merged ?? event);
    }
  }

  /** Switches the log to another chat and loads that chat's saved events. */
  function switchLog(id: string, load: boolean) {
    chatIdRef.current = id;
    eventsRef.current = [];
    setEvents([]);
    warnedRef.current = { context: new Set(), budget: false };
    if (!load) return;
    loadChatActivity(id).then((saved) => {
      if (chatIdRef.current !== id) return; // you moved on while it loaded
      eventsRef.current = mergeEvents(saved, eventsRef.current);
      setEvents(eventsRef.current);
    });
  }

  function newChat() {
    const id = newId();
    setChatId(id);
    switchLog(id, false);
    setChatMeta({});
    setStopped(false);
    setClosedMidRun(false);
    setMessages([]);
    setProjects([]);
    setSubagents({});
    setUsageBoth(emptyUsage());
    setLastUsage(null);
    setEditing(null);
    setRuns([]);
    setChanged({});
    updateQueue(() => []);
    setError("");
  }

  function setRuns(runs: CheckpointRun[]) {
    checkpointRunsRef.current = runs;
    setCheckpointRuns(runs);
  }

  /** Looks at each open project's git state for the badges in the header. */
  async function refreshGit(names = projects.map((p) => p.name)) {
    if (!workspace) return;
    const entries = await Promise.all(
      names.map(async (name) => [name, await gitStatus(workspace, name).catch(() => undefined)] as const),
    );
    setGitInfo((old) => {
      const next = { ...old };
      for (const [name, info] of entries) {
        if (info) next[name] = info;
        else delete next[name];
      }
      return next;
    });
  }

  /** Before the agent's first change to a project in this chat, put the chat on its own branch (if that's switched on). */
  async function prepareBranch(project: string, forChat: string, title: string) {
    if (!branchPerChat || !workspace) return;
    const key = `${forChat}:${project}`;
    if (branchedRef.current.has(key)) return;
    branchedRef.current.add(key);
    const info = await gitStatus(workspace, project);
    if (!isShowable(info) || info.blocked || isChatBranch(info.branch)) return;
    const name = branchName(title, forChat);
    try {
      await gitCreateBranch(workspace, project, name);
      emitEvent({ category: "chat", summary: `Put ${project} on a new branch, ${name}, before the first change` }, forChat);
      setNotice(`${project} is now on the branch ${name}.`);
      void refreshGit([project]);
    } catch (e) {
      emitEvent({ category: "chat", level: "warn", summary: `Didn't make a branch for ${project}: ${String(e)}` }, forChat);
      setNotice(`Didn't make a branch for ${project}: ${String(e)}`);
    }
  }

  /** Asks Rust how many files each turn changed, and forgets runs that changed none. */
  async function refreshChanged(forChat: string, runs: CheckpointRun[]) {
    try {
      const status = await checkpointStatus(forChat, runs);
      if (chatIdRef.current !== forChat) return;
      setChanged(changedByTurn(runs, status));
      const live = runs.filter((r) => (status.find((s) => s.runId === r.run)?.files ?? 0) > 0);
      if (live.length !== runs.length && checkpointRunsRef.current === runs) setRuns(live);
    } catch {
      // no undo information available: the buttons just don't show
    }
  }

  /** Puts a chat on screen. */
  function showChat(c: Conversation) {
    // A chat cut off by closing the app can have tool calls with no results, which the API refuses.
    const fixed = repairMessages(c.messages);
    const subs = repairSubagents(c.subagents);
    setChatId(c.id);
    switchLog(c.id, true);
    setChatMeta({ title: c.title, titleEdited: c.titleEdited, pinned: c.pinned, budgetExtra: c.budgetExtra, forkedFrom: c.forkedFrom });
    setStopped(c.stopped === true);
    setClosedMidRun(fixed.repaired || subs.repaired);
    setMessages(fixed.messages);
    setProjects(c.projects);
    setSubagents(subs.subagents);
    setUsageBoth(c.usage ?? emptyUsage());
    setLastUsage(null);
    setEditing(null);
    setRuns(c.checkpoints ?? []);
    setChanged({});
    void refreshChanged(c.id, c.checkpoints ?? []);
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
    invoke("checkpoint_delete_chat", { chatId: id }).catch(() => {});
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

  /** The agent proposed a plan in Plan mode; you're happy with it. Edits can go through now, commands still ask. */
  function approvePlan() {
    if (busy) return;
    changeMode("acceptEdits", true);
    run([...messages, { role: "user", content: "The plan is approved. Go ahead and carry it out." }]);
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

  /** Shows what undoing a turn's file changes would do, and waits for you to confirm. */
  async function startRevert(turn: number) {
    if (busy) return;
    const runIds = runsFrom(checkpointRunsRef.current, turn, true);
    try {
      setRevertPlan({ runIds, summary: describePlan(await previewRevert(chatIdRef.current, runIds)) });
    } catch (e) {
      setError(`Undo: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Reverts runs and reports what happened. Files you changed since are left alone unless `force`. */
  async function undoRuns(runIds: string[], force: boolean) {
    const forChat = chatIdRef.current;
    try {
      const result = await revertRuns(forChat, runIds, force);
      const text = summarizeRevert(result);
      setNotice(text);
      emitEvent({ category: "chat", level: result.skipped.length ? "warn" : "info", summary: text }, forChat);
    } catch (e) {
      setError(`Undo: ${e instanceof Error ? e.message : String(e)}`);
    }
    await refreshChanged(forChat, checkpointRunsRef.current);
    void refreshGit();
  }

  async function confirmRevert(force: boolean) {
    const plan = revertPlan;
    setRevertPlan(null);
    if (plan) await undoRuns(plan.runIds, force);
  }

  /** Throws away the last reply and asks again. */
  async function regenerate() {
    if (busy) return;
    const at = messages.map((m) => m.role).lastIndexOf("user");
    if (at === -1) return;
    // If the reply changed files or ran commands, say so first (and offer to undo the files).
    if (actedIn(messages.slice(at + 1))) setRegenChoice(at);
    else regenerateFrom(at, false);
  }

  async function regenerateFrom(at: number, undo: boolean) {
    setRegenChoice(null);
    if (undo) await undoRuns(runsFrom(checkpointRunsRef.current, at), false);
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

  async function editInPlace() {
    const choice = editChoice;
    setEditChoice(null);
    if (!choice || busy) return;
    if (undoDiscarded && filesFrom(changed, choice.index) > 0) await undoRuns(runsFrom(checkpointRunsRef.current, choice.index), false);
    const kept = messages.slice(0, choice.index);
    run([...kept, { role: "user", content: choice.text }], { subagents: subagentsFor(kept) });
  }

  async function exportChat(format: "md" | "json") {
    if (messages.length === 0) return;
    const convo = buildConversation({ id: chatId, meta: chatMeta, messages, projects, subagents, usage, stopped, checkpoints: checkpointRuns });
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
    const turn = history.map((m) => m.role).lastIndexOf("user"); // costs and undo are kept per turn
    const runId = newId();
    setRuns([...checkpointRunsRef.current, { run: runId, turn }]);
    const chatCap = effectiveCap(limits.budgetUsd, meta.budgetExtra);
    const emit = (draft: ActivityDraft) => emitEvent(draft, id);
    const runRef = `run-${id}-${Date.now()}`;
    let failure: string | undefined;
    emit({
      category: "run", ref: runRef, pending: true, summary: `Run started with ${model}`,
      detail: {
        mode: modeRef.current, messages: history.length, projects: projects.map((p) => `${p.name}${p.writable ? "" : " (read-only)"}`),
        ...(chatCap > 0 ? { budget: chatCap } : {}),
      },
    });

    const snapshot = (wasStopped = false) =>
      buildConversation({ id, meta, messages: latest, projects: latestProjects, subagents: subs, usage: usageRef.current, stopped: wasStopped, checkpoints: checkpointRunsRef.current });
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
      emit({ category: "error", level: "error", summary: `Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}` });
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
        redact: redactOn,
        checkpoint: { chatId: id, runId },
        beforeWrite: (project) => prepareBranch(project, id, meta.titleEdited && meta.title ? meta.title : autoTitle(latest)),
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
          const total = addUsage(usageRef.current, u, price, turn);
          setUsageBoth(total);
          // Say once when the conversation or the budget is getting full.
          const warned = warnedRef.current;
          if (u.role === "main" && contextWindow) {
            for (const tier of [0.9, 0.7]) {
              if (u.promptTokens / contextWindow >= tier && !warned.context.has(tier)) {
                warned.context.add(tier);
                if (tier === 0.9) warned.context.add(0.7);
                emit({ category: "chat", level: "warn", summary: `The conversation fills ${Math.round((u.promptTokens / contextWindow) * 100)}% of the model's context` });
                break;
              }
            }
          }
          if (!warned.budget && budgetState(total.cost, chatCap) === "warn") {
            warned.budget = true;
            emit({ category: "chat", level: "warn", summary: `This chat has used 80% of its ${formatCost(chatCap)} budget` });
          }
        },
        onEvent: emit,
        overBudget: () => (chatCap > 0 && usageRef.current.cost >= chatCap ? chatCap : null),
        takeSteering: () => {
          const mine = queueRef.current.filter((q) => q.steering);
          if (mine.length === 0) return [];
          updateQueue((q) => q.filter((x) => !x.steering));
          return mine.map((q) => q.text);
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        failure = e instanceof Error ? e.message : String(e);
        setError(failure);
      }
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
      const ending = runState(latest);
      emit({
        category: "run", ref: runRef,
        level: failure ? "error" : wasStopped || ending !== "done" ? "warn" : "info",
        summary: failure ? `Run failed: ${failure}`
          : wasStopped ? "Run stopped by you"
          : ending === "limit" ? "Run stopped at the step limit"
          : ending === "budget" ? "Run stopped at the budget"
          : ending === "done" ? "Run finished" : "Run ended without an answer",
        detail: { messages: latest.length },
      });
      try {
        await saveConversation(workspace, snapshot(wasStopped));
        setChats(await listChats(workspace));
        await refreshChanged(id, checkpointRunsRef.current);
        void refreshGit(latestProjects.map((p) => p.name));
      } catch (e) {
        setError(`Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}`);
        emit({ category: "error", level: "error", summary: `Couldn't save this chat: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  async function exportActivity(visible: ActivityEvent[]) {
    try {
      const path = await save({ defaultPath: exportFileName(`${chatMeta.title ?? autoTitle(messages)} activity`, "json"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await invoke("write_export", { path, contents: JSON.stringify(visible, null, 2) });
      setNotice(`Saved ${baseName(path)}.`);
    } catch (e) {
      setError(`Export: ${e instanceof Error ? e.message : String(e)}`);
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
                <SidebarMenuButton size="sm" onClick={() => setPermissionsOpen(true)}>
                  <ShieldCheckIcon />
                  <span>Always allowed…</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex h-svh min-w-0 flex-col">
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
                  {isShowable(gitInfo[p.name]) && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setChangesFor(p.name)}
                      title={gitInfo[p.name].blocked ?? `${describeGit(gitInfo[p.name])}. Click to see the changes.`}
                      className={isChatBranch(gitInfo[p.name].branch) ? "text-blue-600 dark:text-blue-400" : ""}
                    >
                      <GitBranchIcon />
                      <span className="max-w-32 truncate">{gitInfo[p.name].branch ?? "no commits"}</span>
                      {gitInfo[p.name].changed + gitInfo[p.name].untracked > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">●{gitInfo[p.name].changed + gitInfo[p.name].untracked}</span>
                      )}
                    </Button>
                  )}
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
              <Button
                size="icon-xs"
                variant={activityOpen ? "default" : "outline"}
                aria-label="Activity log"
                aria-pressed={activityOpen}
                title="Activity log: everything the agent is doing"
                onClick={() => {
                  setActivityOpen(!activityOpen);
                  setSetting("activityOpen", !activityOpen);
                }}
              >
                <ActivityIcon />
              </Button>
              <CostChip usage={usage} cap={cap} onAddBudget={addBudget} disabled={busy} />
              <ExportMenu
                disabled={messages.length === 0}
                fullOutput={fullOutput}
                onFullOutputChange={setFullOutput}
                onExport={exportChat}
              />
              <LimitsPopover
                branchPerChat={branchPerChat}
                onBranchPerChatChange={(on) => {
                  setBranchPerChat(on);
                  setSetting("gitBranchPerChat", on);
                }}
                redact={redactOn}
                onRedactChange={(on) => {
                  setRedactOn(on);
                  setSetting("redact", on);
                }}
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
                changedTurns={changed}
                onRevert={startRevert}
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
                {mode === "plan" && state === "done" && (
                  <Button size="sm" onClick={approvePlan} title="Switch to Auto-accept edits and tell the agent to go ahead">
                    <PlayIcon />
                    Approve plan
                  </Button>
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
                    {pending.req.mode && ` · ${MODES.find((m) => m.id === pending.req.mode)?.label ?? ""}`}
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
                  <Button size="sm" variant={pending.req.danger ? "destructive" : "default"} onClick={() => answer("once")}>
                    {pending.req.danger ? "Approve anyway" : "Approve"}
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
                    {pending.req.danger && (
                      <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
                        <strong>Flagged: </strong>
                        {pending.req.danger} This check is a guardrail, not a guarantee: read the command yourself.
                      </p>
                    )}
                    {pending.req.warning && (
                      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                        {pending.req.warning}
                      </p>
                    )}
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
                    if (e.key === "Tab" && e.shiftKey) {
                      e.preventDefault();
                      changeMode(nextMode(mode), true);
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <InputGroupAddon align="block-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <InputGroupButton size="sm" className={MODES.find((m) => m.id === mode)?.tone} title="Permission mode (Shift+Tab to change)">
                        {MODES.find((m) => m.id === mode)?.label}
                        <ChevronDownIcon />
                      </InputGroupButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                      <DropdownMenuRadioGroup value={mode} onValueChange={(v) => changeMode(v as Mode, true)}>
                        {MODES.map((m) => (
                          <DropdownMenuRadioItem key={m.id} value={m.id} className="items-start">
                            <span className="flex flex-col">
                              <span className={m.tone}>{m.label}</span>
                              <span className="text-xs font-normal text-muted-foreground">{m.hint}</span>
                            </span>
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

        {activityOpen && (
          <ActivityPanel
            events={events}
            width={activityWidth}
            onWidthChange={(w, final) => {
              setActivityWidth(w);
              if (final) setSetting("activityWidth", w);
            }}
            onClose={() => {
              setActivityOpen(false);
              setSetting("activityOpen", false);
            }}
            onClear={() => {
              eventsRef.current = [];
              setEvents([]);
            }}
            onExport={exportActivity}
          />
        )}
      </SidebarProvider>

      <AlertDialog open={regenChoice !== null} onOpenChange={(open) => !open && setRegenChoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate this reply?</AlertDialogTitle>
            <AlertDialogDescription>
              The reply changed files or ran commands. Regenerating starts it over. It can't take back commands that already ran.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {regenChoice !== null && filesFrom(changed, regenChoice) > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox id="undo-regen" checked={undoDiscarded} onCheckedChange={(v) => setUndoDiscarded(v === true)} />
              <Label htmlFor="undo-regen">
                Also undo the {filesFrom(changed, regenChoice)} file {filesFrom(changed, regenChoice) === 1 ? "change" : "changes"} it made
              </Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => regenChoice !== null && regenerateFrom(regenChoice, undoDiscarded && filesFrom(changed, regenChoice) > 0)}>
              Regenerate
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revertPlan !== null} onOpenChange={(open) => !open && setRevertPlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this reply's file changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {revertPlan && revertPlan.summary.lines.length === 0
                ? "Every file is already as it was before the reply."
                : "Files are put back to how they were before the agent changed them. Commands the agent ran (installs, deleted files, git) are not undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revertPlan && revertPlan.summary.lines.length > 0 && (
            <ul className="max-h-60 overflow-y-auto rounded-md border p-2 text-xs">
              {revertPlan.summary.lines.map((line) => (
                <li key={line.text} className={line.conflict ? "text-amber-700 dark:text-amber-400" : ""}>
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          {revertPlan && revertPlan.summary.conflicts > 0 && (
            <p className="text-sm text-muted-foreground">
              {revertPlan.summary.conflicts === 1 ? "One file was" : `${revertPlan.summary.conflicts} files were`} changed since the agent wrote
              {revertPlan.summary.conflicts === 1 ? " it" : " them"}. "Undo the rest" leaves {revertPlan.summary.conflicts === 1 ? "it" : "them"} alone; "Overwrite everything" puts back
              the agent's starting version and loses your changes.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {revertPlan && revertPlan.summary.conflicts > 0 && (
              <Button variant="destructive" onClick={() => confirmRevert(true)}>
                Overwrite everything
              </Button>
            )}
            <Button onClick={() => confirmRevert(false)}>{revertPlan && revertPlan.summary.conflicts > 0 ? "Undo the rest" : "Undo"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {changesFor && apiKey && workspace && (
        <ChangesDialog
          open
          onOpenChange={(open) => !open && setChangesFor(null)}
          workspace={workspace}
          project={changesFor}
          info={gitInfo[changesFor]}
          apiKey={apiKey}
          model={model}
          busy={busy}
          onCommitted={(summary) => {
            setNotice(`Committed ${changesFor}: ${summary}`);
            emitEvent({ category: "chat", summary: `You committed in ${changesFor}: ${summary}` }, chatIdRef.current);
            void refreshGit([changesFor]);
          }}
        />
      )}

      <PermissionsDialog open={permissionsOpen} onOpenChange={setPermissionsOpen} workspace={workspace} />

      <AlertDialog open={editChoice !== null} onOpenChange={(open) => !open && setEditChoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resend this message?</AlertDialogTitle>
            <AlertDialogDescription>
              Editing a message restarts the conversation from that point. Branch off to keep this chat as it is, or replace
              everything after the message in this chat.
              {editChoice && actedIn(messages.slice(editChoice.index + 1)) &&
                " Neither choice undoes commands the agent already ran, and a new chat starts with the files as they are now."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {editChoice && filesFrom(changed, editChoice.index) > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox id="undo-edit" checked={undoDiscarded} onCheckedChange={(v) => setUndoDiscarded(v === true)} />
              <Label htmlFor="undo-edit">
                When replacing, also undo the {filesFrom(changed, editChoice.index)} file {filesFrom(changed, editChoice.index) === 1 ? "change" : "changes"} made after this message
              </Label>
            </div>
          )}
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
