import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertCircleIcon,
  ActivityIcon,
  ArrowUpIcon,
  AsteriskIcon,
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
  SettingsIcon,
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
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_MODEL, loadInstructions, systemPrompt, toolsFor } from "./agent";
import { textOf } from "./text";
import ActivityPanel, { MAX_WIDTH, MIN_WIDTH } from "./ActivityPanel";
import { type ActivityEvent } from "./activity";
import { flushActivity, loadChatActivity, saveActivity } from "./auditLog";
import ChangesDialog from "./ChangesDialog";
import ChatList from "./ChatList";
import { checkpointStatus, describePlan, filesFrom, previewRevert, revertRuns, runsFrom, type PlanSummary } from "./checkpoints";
import CostChip, { budgetStep } from "./CostChip";
import ContextMeter from "./ContextMeter";
import { contextBreakdown } from "./context";
import { view } from "./compaction";
import { effectiveCap, formatCost } from "./cost";
import ExportMenu from "./ExportMenu";
import { chatToJson, chatToMarkdown, exportFileName } from "./exportChat";
import { describeGit, gitCreateBranch, gitStatus, isChatBranch, isShowable, type GitInfo } from "./git";
import { runState, type RunState } from "./history";
import { formatInstructions, type ProjectInstructions } from "./instructions";
import DiffView from "./DiffView";
import ModelPicker from "./ModelPicker";
import SettingsDialog from "./SettingsDialog";
import { DEFAULT_LIMITS, resolveLimits, type Limits } from "./limits";
import MultiEditDiff from "./MultiEditDiff";
import QuestionCard from "./QuestionCard";
import TodoList from "./TodoList";
import { fetchToolModels, type ModelInfo } from "./models";
import MessageList, { type EditingMessage } from "./Messages";
import { polish, startRecording, transcribe, type Recording } from "./dictation";
import { MODES, nextMode, type Approval } from "./permissions";
import PermissionsDialog from "./PermissionsDialog";
import { computerName, isWindows, keyStoreName } from "./platform";
import { actedIn, blankSession, createController, isBusy, titleOf, useSession, useSummaries } from "./sessions";
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
  type Mode,
} from "./storage";

const STATE_NOTE: Record<RunState, string> = {
  none: "",
  done: "",
  stopped: "Stopped.",
  limit: "The agent used up its steps before finishing.",
  budget: "This chat reached its budget.",
  unfinished: "This run didn't finish.",
};
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const baseName = (p: string) =>
  p
    .split(isWindows ? /[\\/]/ : "/")
    .filter(Boolean)
    .pop() ?? p;

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

/** A desktop notification, when the app is in the background and you've asked for them. */
async function sendDesktopNotification(title: string, body: string) {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
    sendNotification({ title, body });
  } catch {
    // no notifications here: the sidebar still shows the news
  }
}

// What the controller reads. App keeps these up to date on every render; the chats themselves
// don't live in React, so a run carries on whichever chat is on screen.
const live = {
  current: {
    apiKey: null as string | null,
    workspace: null as string | null,
    model: DEFAULT_MODEL,
    limits: DEFAULT_LIMITS,
    redact: true,
    branchPerChat: false,
    defaultMode: "ask" as Mode,
    notifyOn: false,
    autoCompact: true,
  },
};
const models: { current: ModelInfo[] } = { current: [] };
const actions = {
  refreshChats: () => {},
  refreshGit: (_names?: string[]) => {},
};

const ctl = createController({
  workspace: () => live.current.workspace,
  apiKey: () => live.current.apiKey,
  model: () => live.current.model,
  limits: () => live.current.limits,
  redact: () => live.current.redact,
  branchPerChat: () => live.current.branchPerChat,
  defaultMode: () => live.current.defaultMode,
  modelInfo: (id) => models.current.find((m) => m.id === id),
  saveChat: saveConversation,
  saveActivity,
  loadActivity: loadChatActivity,
  chatsChanged: () => actions.refreshChats(),
  gitStatus,
  gitCreateBranch,
  gitChanged: (names) => actions.refreshGit(names),
  checkpointStatus,
  revertRuns,
  cancelCommands: (runId) => void invoke("cancel_commands", { runId }).catch(() => {}),
  autoCompact: () => live.current.autoCompact,
  notify: (title, body) => {
    if (live.current.notifyOn && !document.hasFocus()) void sendDesktopNotification(title, body);
  },
});
const firstChat = ctl.create().id;
ctl.activate(firstChat);

export default function App() {
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined); // undefined = loading
  const [keyInput, setKeyInput] = useState("");
  const [workspace, setWorkspace] = useState<string | null | undefined>(undefined);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [defaultMode, setDefaultMode] = useState<Mode>("ask"); // what a new chat starts in
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [appError, setAppError] = useState(""); // trouble with the key or workspace, before any chat
  const [chatId, setChatId] = useState(firstChat); // the chat on screen
  const [polishOn, setPolishOn] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [limitsReady, setLimitsReady] = useState(false);
  const [redactOn, setRedactOn] = useState(true); // hide secrets from the model
  const [branchPerChat, setBranchPerChat] = useState(false); // put each chat's changes on their own git branch
  const [autoCompactOn, setAutoCompactOn] = useState(true); // summarize old messages when a chat fills the model's window
  const [notifyOn, setNotifyOn] = useState(false); // tell me when a chat finishes or needs me while the app is in the background
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [instructions, setInstructions] = useState<ProjectInstructions[]>([]); // CLAUDE.md of the open projects
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  const [editChoice, setEditChoice] = useState<EditingMessage | null>(null); // asks: fork or replace?
  const [fullOutput, setFullOutput] = useState(false); // exports: keep whole tool results
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [revertPlan, setRevertPlan] = useState<{
    runIds: string[];
    summary: PlanSummary;
  } | null>(null);
  const [regenChoice, setRegenChoice] = useState<number | null>(null); // index of the message being answered again
  const [undoDiscarded, setUndoDiscarded] = useState(true); // the checkbox on the regenerate and edit dialogs
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo>>({}); // by project name
  const [changesFor, setChangesFor] = useState<string | null>(null); // the project whose Changes dialog is open
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityWidth, setActivityWidth] = useState(420);
  const [dictation, setDictation] = useState<"idle" | "recording" | "working">("idle");
  const recordingRef = useRef<Promise<Recording> | null>(null);
  const dictationChat = useRef(chatId); // where dictated text goes: the chat you were in when you started

  // The chat on screen, and a short summary of every chat for the sidebar.
  const s = useSession(ctl.store, chatId) ?? blankSession(chatId, defaultMode, 0);
  const summaries = useSummaries(ctl.store);
  const { messages, projects, subagents, streaming, usage, events, queue, approvals, notice, stopped, closedMidRun, lastUsage, changed } =
    s;
  const error = s.error;
  const busy = isBusy(s);
  const isEmpty = messages.length === 0 && !streaming;
  const state = runState(messages, stopped);
  const cap = effectiveCap(limits.budgetUsd, s.meta.budgetExtra); // this chat's spending limit; 0 = none
  const pending = approvals[0];
  const asked = s.questions[0];
  const waitingSubagents = new Set(approvals.flatMap((p) => (p.req.owner ? [p.req.owner] : [])));

  const waitingOnYou = [...summaries].filter(([, v]) => v.needsYou).map(([id]) => id);
  const workingCount = [...summaries].filter(([, v]) => v.phase !== "idle").length;

  live.current = {
    apiKey: apiKey ?? null,
    workspace: workspace ?? null,
    model,
    limits,
    redact: redactOn,
    branchPerChat,
    defaultMode,
    notifyOn,
    autoCompact: autoCompactOn,
  };

  /** Looks at each open project's git state for the badges in the header. */
  async function refreshGit(names: string[] = projects.map((p) => p.name)) {
    if (!workspace) return;
    const entries = await Promise.all(names.map(async (name) => [name, await gitStatus(workspace, name).catch(() => undefined)] as const));
    setGitInfo((old) => {
      const next = { ...old };
      for (const [name, info] of entries) {
        if (info) next[name] = info;
        else delete next[name];
      }
      return next;
    });
  }
  actions.refreshChats = () => {
    const ws = live.current.workspace;
    if (ws) void listChats(ws).then(setChats);
  };
  actions.refreshGit = (names) => void refreshGit(names);

  // Look for a CLAUDE.md in each open project, so you can see which ones the agent is following.
  useEffect(() => {
    if (!workspace) return;
    let current = true;
    loadInstructions(workspace, projects).then((list) => current && setInstructions(list));
    return () => {
      current = false;
    };
  }, [workspace, projects]);

  // The selected model's context size comes from OpenRouter's model list (fetched once and cached).
  useEffect(() => {
    if (!apiKey) return;
    let current = true;
    fetchToolModels(apiKey)
      .then((list) => {
        models.current = list;
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
        systemText: systemPrompt({
          role: "main",
          projects,
          workspace: workspace ?? "",
        }),
        toolsText: JSON.stringify(toolsFor("main")),
        instructionsText: formatInstructions(instructions),
        messages: view(messages, s.compaction), // what the model is actually sent
        streaming,
        window: contextWindow,
      }),
    [projects, workspace, instructions, messages, s.compaction, streaming, contextWindow],
  );

  // On startup: read the key from the system credential store and restore settings.
  useEffect(() => {
    invoke<string | null>("get_api_key")
      .then(setApiKey)
      .catch((e) => {
        setAppError(String(e));
        setApiKey(null);
      });
    getSetting<string | null>("workspace", null).then(setWorkspace);
    getSetting("model", DEFAULT_MODEL).then(setModel);
    getSetting<Mode>("mode", "ask").then((m) => {
      setDefaultMode(m);
      live.current.defaultMode = m;
      // a chat you haven't typed in yet starts in your usual mode
      const first = ctl.store.get(firstChat);
      if (first && first.messages.length === 0) ctl.setMode(firstChat, m);
    });
    getSetting("polish", true).then(setPolishOn);
    getSetting<Partial<Limits>>("limits", {}).then((l) => {
      setLimits(resolveLimits(l));
      setLimitsReady(true);
    });
    getSetting("redact", true).then(setRedactOn);
    getSetting("gitBranchPerChat", false).then(setBranchPerChat);
    getSetting("notifyOn", false).then(setNotifyOn);
    getSetting("autoCompact", true).then(setAutoCompactOn);
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
    invoke("checkpoint_prune", {
      maxAgeDays: limits.checkpointDays,
      maxMegabytes: limits.checkpointMb,
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, limitsReady]);

  // Write any activity still waiting to be saved when the window closes (best effort).
  useEffect(() => {
    const flush = () => void flushActivity();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // Closing the window with agents still working asks first.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          const n = ctl.runningIds().length;
          if (n === 0) return;
          const ok = await confirm(
            `${n === 1 ? "A chat is" : `${n} chats are`} still working. If you quit now, ${n === 1 ? "it" : "they"} will stop where ${n === 1 ? "it is" : "they are"}. You can pick ${n === 1 ? "it" : "them"} up again with Continue.`,
            {
              title: "Quit billybot?",
              kind: "warning",
              okLabel: "Quit",
              cancelLabel: "Keep working",
            },
          );
          if (!ok) event.preventDefault();
          else ctl.stopAll();
        })
        .then((u) => (unlisten = u))
        .catch(() => {});
    } catch {
      // not running inside the app (a browser tab, for instance)
    }
    return () => unlisten?.();
  }, []);

  // Load this workspace's chats.
  useEffect(() => {
    if (workspace) void listChats(workspace).then(setChats);
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

  /** This chat's mode, and the mode new chats start in. */
  function changeMode(m: Mode) {
    ctl.setMode(chatId, m, true);
    setDefaultMode(m);
    setSetting("mode", m);
  }

  async function saveKey() {
    try {
      await invoke("set_api_key", { key: keyInput });
      setApiKey(keyInput.trim());
      setKeyInput("");
      setAppError("");
    } catch (e) {
      setAppError(String(e));
    }
  }

  async function pickWorkspace() {
    const picked = await open({
      directory: true,
      title: "Choose your workspace folder",
    });
    if (typeof picked !== "string") return;
    try {
      const ws = await invoke<string>("check_workspace", { path: picked });
      if (ctl.anyRunning()) {
        const n = ctl.runningIds().length;
        const ok = await confirm(
          `${n === 1 ? "A chat is" : `${n} chats are`} working in this workspace. Switching stops ${n === 1 ? "it" : "them"}.`,
          {
            title: "Switch workspace?",
            kind: "warning",
            okLabel: "Stop and switch",
            cancelLabel: "Stay",
          },
        );
        if (!ok) return;
      }
      ctl.reset();
      setChats([]);
      setGitInfo({});
      setWorkspace(ws);
      live.current.workspace = ws;
      setSetting("workspace", ws);
      setAppError("");
      showChat(ctl.create().id);
    } catch (e) {
      setAppError(String(e));
    }
  }

  // ---------- Switching between chats ----------

  function showChat(id: string) {
    setChatId(id);
    ctl.activate(id);
    setEditing(null);
  }

  function newChat() {
    // an empty chat is already a new chat
    if (messages.length === 0 && !s.draft && !busy) return;
    showChat(ctl.create().id);
  }

  async function openChat(id: string) {
    if (!workspace) return;
    if (ctl.store.has(id)) {
      showChat(id); // a chat that is working shows what it is doing right now
      return;
    }
    const c = await loadChat(workspace, id);
    if (!c) {
      ctl.setError(chatId, "That chat couldn't be opened. It may have been deleted or damaged.");
      setChats(await listChats(workspace));
      return;
    }
    ctl.ensure(c);
    showChat(id);
  }

  async function removeChat(id: string) {
    if (!workspace) return;
    if (!ctl.remove(id)) {
      ctl.setNotice(chatId, "That chat is working. Stop it before deleting it.");
      return;
    }
    await deleteConversation(workspace, id);
    invoke("checkpoint_delete_chat", { chatId: id }).catch(() => {});
    setChats(await listChats(workspace));
    if (id === chatId) newChat();
  }

  async function renameChat(id: string, title: string) {
    if (!workspace) return;
    if (ctl.store.has(id)) ctl.updateMeta(id, { title });
    else await updateChatMeta(workspace, id, { title });
    setChats(await listChats(workspace));
  }

  async function pinChat(id: string, pinned: boolean) {
    if (!workspace) return;
    if (ctl.store.has(id)) ctl.updateMeta(id, { pinned });
    else await updateChatMeta(workspace, id, { pinned });
    setChats(await listChats(workspace));
  }

  // You can close a project or flip it between read-only and writable yourself.
  function toggleWritable(name: string) {
    ctl.setProjects(chatId, (ps) => ps.map((p) => (p.name === name ? { ...p, writable: !p.writable } : p)));
  }
  function closeProject(name: string) {
    ctl.setProjects(chatId, (ps) => ps.filter((p) => p.name !== name));
  }

  // ---------- Working in the chat on screen ----------

  function answer(a: Approval) {
    ctl.answer(chatId, a);
  }

  async function stop() {
    ctl.stop(chatId);
    // Queued messages were meant for a run that is over. Ask before throwing away more than one.
    const waiting = ctl.store.get(chatId)?.queue.length ?? 0;
    if (waiting === 0) return;
    const clear =
      waiting === 1 ||
      (await confirm(`Also discard the ${waiting} messages waiting in the queue?`, {
        title: "Stop",
        okLabel: "Discard",
        cancelLabel: "Keep them",
      }));
    if (clear) ctl.clearQueue(chatId);
    else ctl.keepQueue(chatId);
  }

  function stopAll() {
    ctl.stopAll();
  }

  function send() {
    ctl.send(chatId, s.draft);
  }

  function editQueued(id: string) {
    const text = ctl.takeQueued(chatId, id);
    if (text !== null) ctl.setDraft(chatId, text);
  }

  /** Shows what undoing a turn's file changes would do, and waits for you to confirm. */
  async function startRevert(turn: number) {
    if (busy) return;
    const runIds = runsFrom(s.runs, turn, true);
    try {
      setRevertPlan({
        runIds,
        summary: describePlan(await previewRevert(chatId, runIds)),
      });
    } catch (e) {
      ctl.setError(chatId, `Undo: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function confirmRevert(force: boolean) {
    const plan = revertPlan;
    setRevertPlan(null);
    if (plan) await ctl.undoRuns(chatId, plan.runIds, force);
  }

  /** Throws away the last reply and asks again. */
  function regenerate() {
    if (busy) return;
    const at = messages.map((m) => m.role).lastIndexOf("user");
    if (at === -1) return;
    // If the reply changed files or ran commands, say so first (and offer to undo the files).
    if (actedIn(messages.slice(at + 1))) setRegenChoice(at);
    else void ctl.regenerate(chatId, false);
  }

  function regenerateConfirmed(undo: boolean) {
    setRegenChoice(null);
    void ctl.regenerate(chatId, undo);
  }

  async function forkChat(index: number) {
    const id = await ctl.fork(chatId, index);
    if (id) showChat(id);
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
    if (!choice) return;
    const id = await ctl.editInFork(chatId, choice.index, choice.text);
    if (id) showChat(id);
  }

  function editInPlace() {
    const choice = editChoice;
    setEditChoice(null);
    if (!choice) return;
    setEditing(null);
    void ctl.editInPlace(chatId, choice.index, choice.text, undoDiscarded && filesFrom(changed, choice.index) > 0);
  }

  async function exportChat(format: "md" | "json") {
    const convo = ctl.snapshot(chatId, false);
    if (!convo || convo.messages.length === 0) return;
    const options = { fullToolOutput: fullOutput };
    const text = format === "md" ? chatToMarkdown(convo, options) : chatToJson(convo, options);
    try {
      const path = await save({
        defaultPath: exportFileName(convo.title, format),
        filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
      });
      if (!path) return;
      await invoke("write_export", { path, contents: text });
      ctl.setNotice(chatId, `Saved ${baseName(path)}. Secrets were redacted.`);
    } catch (e) {
      ctl.setError(chatId, `Export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function exportActivity(visible: ActivityEvent[]) {
    try {
      const path = await save({
        defaultPath: exportFileName(`${titleOf(s)} activity`, "json"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_export", {
        path,
        contents: JSON.stringify(visible, null, 2),
      });
      ctl.setNotice(chatId, `Saved ${baseName(path)}.`);
    } catch (e) {
      ctl.setError(chatId, `Export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function startDictation() {
    if (!apiKey || !workspace || recordingRef.current) return;
    ctl.setError(chatId, "");
    dictationChat.current = chatId;
    const pendingRecording = startRecording();
    recordingRef.current = pendingRecording;
    setDictation("recording");
    pendingRecording.catch((e) => {
      recordingRef.current = null;
      setDictation("idle");
      ctl.setError(dictationChat.current, `Microphone: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async function stopDictation() {
    const pendingRecording = recordingRef.current;
    if (!pendingRecording || !apiKey) return;
    recordingRef.current = null;
    setDictation("working");
    const target = dictationChat.current;
    try {
      const recording = await pendingRecording;
      const audio = await recording.stop();
      if (Date.now() - recording.startedAt < 400) return; // a quick tap, not speech
      let text = await transcribe(audio);
      if (text && polishOn) text = await polish(apiKey, text).catch(() => text);
      if (text && ctl.store.has(target)) ctl.appendDraft(target, text);
    } catch (e) {
      ctl.setError(target, `Dictation: ${e instanceof Error ? e.message : String(e)}`);
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
        error={appError}
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
        error={appError}
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

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            {/* Clears the traffic lights and doubles as a window drag handle */}
            <div data-tauri-drag-region className="h-8" />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={pickWorkspace} tooltip={workspace}>
                  <FolderIcon />
                  <span>{baseName(workspace)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={newChat}>
                  <PlusIcon />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {waitingOnYou.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => void openChat(waitingOnYou.find((id) => id !== chatId) ?? waitingOnYou[0])}
                    className="text-amber-700 dark:text-amber-400"
                  >
                    <ShieldCheckIcon />
                    <span>{waitingOnYou.length === 1 ? "1 chat needs you" : `${waitingOnYou.length} chats need you`}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {workingCount > 1 && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={stopAll}>
                    <SquareIcon />
                    <span>Stop all ({workingCount} working)</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <ChatList
              chats={chats}
              activeId={chatId}
              status={summaries}
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
              <SidebarMenuItem>
                <SidebarMenuButton size="sm" onClick={() => setSettingsOpen(true)}>
                  <SettingsIcon />
                  <span>Settings</span>
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
              <CostChip usage={usage} cap={cap} onAddBudget={(dollars) => ctl.addBudget(chatId, dollars)} disabled={busy} />
              <ExportMenu
                disabled={messages.length === 0}
                fullOutput={fullOutput}
                onFullOutputChange={setFullOutput}
                onExport={exportChat}
              />
            </div>
          </header>

          <div className={isEmpty ? "min-h-0 flex-[1.2]" : "min-h-0 flex-1"}>
            {isEmpty ? (
              <div className="flex h-full items-end justify-center px-4 pb-4">
                <h1 className="flex items-center gap-3 font-serif text-4xl">
                  <AsteriskIcon className="size-8 text-orange-400" strokeWidth={2.5} />
                  {greeting()}, Billy
                </h1>
              </div>
            ) : (
              <MessageList
                messages={messages}
                streaming={streaming}
                subagents={subagents}
                turnCosts={usage.turns}
                changedTurns={changed}
                onRevert={startRevert}
                compaction={s.compaction}
                onStopSubagent={(callId) => ctl.stopSubagent(chatId, callId)}
                waitingSubagents={waitingSubagents}
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
            {s.phase === "waiting" && (
              <p className="text-sm text-muted-foreground">
                Waiting for a free slot: {workingCount - 1} other {workingCount - 1 === 1 ? "chat is" : "chats are"} working, and the limit
                is {limits.maxConcurrentRuns}. Change it in Limits.
              </p>
            )}
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
                  <Button size="sm" variant="outline" onClick={() => ctl.addBudgetAndContinue(chatId, budgetStep(cap))}>
                    <PlayIcon />
                    Add {formatCost(budgetStep(cap))} and continue
                  </Button>
                ) : (
                  state !== "done" && (
                    <Button size="sm" variant="outline" onClick={() => ctl.continueRun(chatId)}>
                      <PlayIcon />
                      {messages[messages.length - 1]?.role === "user" ? "Retry" : "Continue"}
                    </Button>
                  )
                )}
                {s.mode === "plan" && state === "done" && (
                  <Button
                    size="sm"
                    onClick={() => ctl.approvePlan(chatId)}
                    title="Switch to Auto-accept edits and tell the agent to go ahead"
                  >
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
                          onClick={() => ctl.sendQueued(chatId, q.id)}
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
                          onClick={() => ctl.removeQueued(chatId, q.id)}
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
            <TodoList items={s.todos} canClear={!busy} onClear={() => ctl.clearTodos(chatId)} />

            {asked && <QuestionCard question={asked} waiting={s.questions.length - 1} onAnswer={(a) => ctl.answerQuestion(chatId, a)} />}

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
                      Runs on your {computerName} as you, starting in {pending.req.where}. The folder lock does not apply to commands: they
                      can reach any file your account can.
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
                    <DiffView before={String(pending.req.args.old_text ?? "")} after={String(pending.req.args.new_text ?? "")} />
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
              <InputGroup className="rounded-2xl">
                <InputGroupTextarea
                  value={s.draft}
                  placeholder={busy ? "Type to queue a message… (Enter to queue)" : "Ask something… (Enter to send, hold ⌘ ⌥ to dictate)"}
                  className="p-3"
                  onChange={(e) => ctl.setDraft(chatId, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Tab" && e.shiftKey) {
                      e.preventDefault();
                      changeMode(nextMode(s.mode));
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <InputGroupAddon align="inline-end" className="self-end">
                  <InputGroupButton
                    size="icon-sm"
                    variant={dictation === "recording" ? "destructive" : "ghost"}
                    onClick={() => (dictation === "recording" ? stopDictation() : startDictation())}
                    disabled={dictation === "working"}
                    aria-label="Dictate (or hold ⌘ ⌥)"
                  >
                    {dictation === "working" ? <Spinner /> : dictation === "recording" ? <SquareIcon /> : <MicIcon />}
                  </InputGroupButton>
                  {busy ? (
                    <InputGroupButton size="icon-sm" variant="default" className="rounded-full" onClick={stop} aria-label="Stop">
                      <SquareIcon />
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      className="rounded-full"
                      disabled={!s.draft.trim()}
                      aria-label="Send"
                    >
                      <ArrowUpIcon />
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
              <div className="flex items-center gap-1 px-2 pt-1 text-muted-foreground">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <InputGroupButton
                      size="sm"
                      className={MODES.find((m) => m.id === s.mode)?.tone}
                      title="Permission mode (Shift+Tab to change)"
                    >
                      {MODES.find((m) => m.id === s.mode)?.label}
                      <ChevronDownIcon />
                    </InputGroupButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuRadioGroup value={s.mode} onValueChange={(v) => changeMode(v as Mode)}>
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
                <div className="ml-auto flex items-center gap-1">
                  <ModelPicker
                    apiKey={apiKey}
                    value={model}
                    disabled={busy}
                    onChange={(id) => {
                      setModel(id);
                      setSetting("model", id);
                    }}
                  />
                  <ContextMeter
                    breakdown={breakdown}
                    lastRequest={lastUsage}
                    compacted={s.compaction && (s.compaction.summary || s.compaction.dropResultsBefore) ? s.compaction : null}
                    canCompact={!busy && messages.length > 0}
                    onCompact={() => void ctl.compactNow(chatId)}
                  />
                </div>
              </div>
            </form>
          </div>
          {isEmpty && <div className="flex-1" />}
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
            onClear={() => ctl.clearEvents(chatId)}
            onExport={exportActivity}
          />
        )}
      </SidebarProvider>
              <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                polish={polishOn}
                onPolishChange={(on) => {
                  setPolishOn(on);
                  setSetting("polish", on);
                }}
                autoCompact={autoCompactOn}
                onAutoCompactChange={(on) => {
                  setAutoCompactOn(on);
                  setSetting("autoCompact", on);
                }}
                notifyOn={notifyOn}
                onNotifyChange={(on) => {
                  setNotifyOn(on);
                  setSetting("notifyOn", on);
                }}
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
            <Button onClick={() => regenChoice !== null && regenerateConfirmed(undoDiscarded && filesFrom(changed, regenChoice) > 0)}>
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
              {revertPlan.summary.conflicts === 1 ? "One file was" : `${revertPlan.summary.conflicts} files were`} changed since the agent
              wrote
              {revertPlan.summary.conflicts === 1 ? " it" : " them"}. "Undo the rest" leaves{" "}
              {revertPlan.summary.conflicts === 1 ? "it" : "them"} alone; "Overwrite everything" puts back the agent's starting version and
              loses your changes.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {revertPlan && revertPlan.summary.conflicts > 0 && (
              <Button variant="destructive" onClick={() => confirmRevert(true)}>
                Overwrite everything
              </Button>
            )}
            <Button onClick={() => confirmRevert(false)}>
              {revertPlan && revertPlan.summary.conflicts > 0 ? "Undo the rest" : "Undo"}
            </Button>
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
            ctl.setNotice(chatId, `Committed ${changesFor}: ${summary}`);
            ctl.emit(chatId, {
              category: "chat",
              summary: `You committed in ${changesFor}: ${summary}`,
            });
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
              Editing a message restarts the conversation from that point. Branch off to keep this chat as it is, or replace everything
              after the message in this chat.
              {editChoice &&
                actedIn(messages.slice(editChoice.index + 1)) &&
                " Neither choice undoes commands the agent already ran, and a new chat starts with the files as they are now."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {editChoice && filesFrom(changed, editChoice.index) > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox id="undo-edit" checked={undoDiscarded} onCheckedChange={(v) => setUndoDiscarded(v === true)} />
              <Label htmlFor="undo-edit">
                When replacing, also undo the {filesFrom(changed, editChoice.index)} file{" "}
                {filesFrom(changed, editChoice.index) === 1 ? "change" : "changes"} made after this message
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
