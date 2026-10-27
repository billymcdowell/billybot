import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  AlertCircleIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  EyeIcon,
  FilePenIcon,
  FolderIcon,
  FolderPlusIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_MODEL, runAgent, textOf } from "./agent";
import DiffView from "./DiffView";
import ModelPicker from "./ModelPicker";
import MessageList from "./Messages";
import { polish, startRecording, transcribe, type Recording } from "./dictation";
import { MODES, type Approval, type ApprovalRequest } from "./permissions";
import {
  clearAlwaysAllowed,
  deleteConversation,
  getSetting,
  listConversations,
  saveConversation,
  setSetting,
  type Conversation,
  type Mode,
  type OpenProject,
  type SubagentRun,
} from "./storage";

type Pending = { req: ApprovalRequest; resolve: (answer: Approval) => void };

const newId = (): string => crypto.randomUUID();
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

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

export default function App() {
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined); // undefined = loading
  const [keyInput, setKeyInput] = useState("");
  const [workspace, setWorkspace] = useState<string | null | undefined>(undefined);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mode, setMode] = useState<Mode>("ask");
  const modeRef = useRef<Mode>("ask");
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chatId, setChatId] = useState(newId);
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
  const recordingRef = useRef<Promise<Recording> | null>(null);

  // On startup: read the key from Keychain and restore settings.
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
  }, []);

  // Load this workspace's chats.
  useEffect(() => {
    if (workspace) listConversations(workspace).then(setChats);
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

  function newChat() {
    setChatId(newId());
    setMessages([]);
    setProjects([]);
    setSubagents({});
    setError("");
  }

  function openChat(c: Conversation) {
    setChatId(c.id);
    setMessages(c.messages);
    setProjects(c.projects ?? []);
    setSubagents(c.subagents ?? {});
    setError("");
  }

  async function removeChat(id: string) {
    if (!workspace) return;
    await deleteConversation(workspace, id);
    setChats(await listConversations(workspace));
    if (id === chatId) newChat();
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

  function stop() {
    abortRef.current?.abort();
    approvals.forEach((p) => p.resolve("deny")); // unblocks anything waiting on you
    setApprovals([]);
  }

  async function send() {
    const text = input.trim();
    if (!text || !workspace || !apiKey || busy) return;
    setInput("");
    setError("");
    setBusy(true);

    const history: ChatCompletionMessageParam[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    const controller = new AbortController();
    abortRef.current = controller;
    let latest = history;
    let latestProjects = projects.map((p) => ({ ...p })); // the loop changes this copy
    let subs = { ...subagents };

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
        messages: history,
        ask,
        signal: controller.signal,
        onUpdate: (msgs, partial) => {
          latest = msgs;
          setMessages([...msgs]);
          setStreaming(partial);
        },
        onSubagent: (id, run) => {
          subs = { ...subs, [id]: run };
          setSubagents(subs);
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming("");
      setBusy(false);
      setApprovals([]);
      setMessages(latest);
      const first = latest.find((m) => m.role === "user");
      const title = textOf(first?.content).slice(0, 40) || "New chat";
      await saveConversation(workspace, {
        id: chatId,
        title,
        updatedAt: Date.now(),
        messages: latest,
        projects: latestProjects,
        subagents: subs,
      });
      setChats(await listConversations(workspace));
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
        description="It's saved in macOS Keychain, never in a file."
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
            <SidebarGroup>
              <SidebarGroupLabel>Chats</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {chats.map((c) => (
                    <SidebarMenuItem key={c.id}>
                      <SidebarMenuButton
                        isActive={c.id === chatId}
                        onClick={() => openChat(c)}
                        disabled={busy}
                        className="h-auto flex-col items-start gap-0"
                      >
                        <span className="w-full truncate">{c.title}</span>
                        {c.projects?.length > 0 && (
                          <span className="w-full truncate text-xs text-muted-foreground">
                            {c.projects.map((p) => p.name).join(", ")}
                          </span>
                        )}
                      </SidebarMenuButton>
                      <SidebarMenuAction showOnHover onClick={() => removeChat(c.id)} disabled={busy}>
                        <Trash2Icon />
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
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
                    title="Switch between read-only and writable"
                  >
                    {p.writable ? <PencilIcon /> : <EyeIcon />}
                    {p.name}
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
              <MessageList messages={messages} streaming={streaming} subagents={subagents} />
            )}
          </div>

          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
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
                      Runs on your Mac as you, starting in {pending.req.where}. The folder lock does not apply to commands:
                      they can reach any file your account can.
                    </p>
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
                  placeholder="Ask something… (Enter to send, hold ⌘ ⌥ to dictate)"
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
    </TooltipProvider>
  );
}
