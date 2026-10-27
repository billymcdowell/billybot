import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  AlertCircleIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FilePenIcon,
  FolderIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_MODEL, runAgent } from "./agent";
import MessageList, { textOf } from "./Messages";
import { MODES, type Approval } from "./permissions";
import {
  clearAlwaysAllowed,
  deleteConversation,
  getSetting,
  listConversations,
  saveConversation,
  setSetting,
  type Conversation,
  type Mode,
} from "./storage";

type Pending = {
  tool: string;
  args: Record<string, unknown>;
  resolve: (answer: Approval) => void;
};

const newId = (): string => crypto.randomUUID();
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export default function App() {
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined); // undefined = loading
  const [keyInput, setKeyInput] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mode, setMode] = useState<Mode>("ask");
  const modeRef = useRef<Mode>("ask");
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chatId, setChatId] = useState(newId);
  const [messages, setMessages] = useState<ChatCompletionMessageParam[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // On startup: read the key from Keychain and restore settings.
  useEffect(() => {
    invoke<string | null>("get_api_key")
      .then(setApiKey)
      .catch((e) => {
        setError(String(e));
        setApiKey(null);
      });
    getSetting<string | null>("folder", null).then(setFolder);
    getSetting("model", DEFAULT_MODEL).then(setModel);
    getSetting<Mode>("mode", "ask").then(changeMode);
  }, []);

  // Whenever the folder changes, load that folder's saved chats.
  useEffect(() => {
    if (folder) listConversations(folder).then(setChats);
  }, [folder]);

  function changeMode(m: Mode) {
    modeRef.current = m; // the running loop reads this, so changes apply immediately
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

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked === "string") {
      setFolder(picked);
      setSetting("folder", picked);
      newChat();
    }
  }

  function newChat() {
    setChatId(newId());
    setMessages([]);
    setError("");
  }

  function openChat(c: Conversation) {
    setChatId(c.id);
    setMessages(c.messages);
    setError("");
  }

  async function removeChat(id: string) {
    if (!folder) return;
    await deleteConversation(folder, id);
    setChats(await listConversations(folder));
    if (id === chatId) newChat();
  }

  // The loop calls this and waits until you click a button on the approval card.
  function ask(tool: string, args: Record<string, unknown>) {
    return new Promise<Approval>((resolve) => setPending({ tool, args, resolve }));
  }

  function answer(a: Approval) {
    pending?.resolve(a);
    setPending(null);
  }

  function stop() {
    abortRef.current?.abort();
    answer("deny"); // unblocks the loop if it is waiting on an approval
  }

  async function send() {
    const text = input.trim();
    if (!text || !folder || !apiKey || busy) return;
    setInput("");
    setError("");
    setBusy(true);

    const history: ChatCompletionMessageParam[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    const controller = new AbortController();
    abortRef.current = controller;
    let latest = history;

    try {
      latest = await runAgent({
        apiKey,
        model,
        folder,
        getMode: () => modeRef.current,
        messages: history,
        ask,
        signal: controller.signal,
        onUpdate: (msgs, partial) => {
          latest = msgs;
          setMessages([...msgs]);
          setStreaming(partial);
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming("");
      setBusy(false);
      setPending(null);
      setMessages(latest);
      // Save the conversation, titled by its first message.
      const first = latest.find((m) => m.role === "user");
      const title = textOf(first?.content).slice(0, 40) || "New chat";
      await saveConversation(folder, { id: chatId, title, updatedAt: Date.now(), messages: latest });
      setChats(await listConversations(folder));
    }
  }

  // ---------- Screens ----------

  if (apiKey === undefined) {
    return (
      <div className="flex h-svh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (apiKey === null) {
    return (
      <div className="flex h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Add your OpenRouter key</CardTitle>
            <CardDescription>It's saved in macOS Keychain, never in a file.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              type="password"
              placeholder="sk-or-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={saveKey} disabled={!keyInput.trim()}>
              Save key
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={pickFolder} disabled={busy} tooltip={folder ?? undefined}>
                  <FolderIcon />
                  <span>{folder ? baseName(folder) : "Choose folder…"}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {folder && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={newChat} disabled={busy}>
                    <PlusIcon />
                    <span>New chat</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Chats</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {chats.map((c) => (
                    <SidebarMenuItem key={c.id}>
                      <SidebarMenuButton isActive={c.id === chatId} onClick={() => openChat(c)} disabled={busy}>
                        <span className="truncate">{c.title}</span>
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
          {folder && (
            <SidebarFooter>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="sm" onClick={() => clearAlwaysAllowed(folder)}>
                    <RotateCcwIcon />
                    <span>Reset "always allow" here</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          )}
        </Sidebar>

        <SidebarInset className="flex h-svh flex-col">
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            <span className="flex-1 truncate text-sm font-medium">{folder ? baseName(folder) : "No folder"}</span>
          </header>

          <div className="min-h-0 flex-1">
            {messages.length === 0 && !streaming ? (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyTitle>{folder ? "What are we working on?" : "Choose a project folder"}</EmptyTitle>
                  <EmptyDescription>
                    {folder
                      ? "Ask about the files in this folder, or ask for a change."
                      : "Use the folder button in the sidebar to pick the folder the agent works in."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <MessageList messages={messages} streaming={streaming} />
            )}
          </div>

          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* The Confirmation pattern: approve or deny before a write runs */}
            {pending && (
              <Item variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <FilePenIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Write {String(pending.args.path)}?</ItemTitle>
                  <ItemDescription>The file is created or overwritten in this folder.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="outline" onClick={() => answer("deny")}>
                    Deny
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => answer("always")}>
                    Always allow here
                  </Button>
                  <Button size="sm" onClick={() => answer("once")}>
                    Approve
                  </Button>
                </ItemActions>
                <ItemFooter>
                  <CodeBlock size="sm">
                    <CodeBlockContent wrap className="max-h-48">
                      {String(pending.args.content ?? "")}
                    </CodeBlockContent>
                  </CodeBlock>
                </ItemFooter>
              </Item>
            )}

            {/* The Prompt Input pattern */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <InputGroup>
                <InputGroupTextarea
                  value={input}
                  placeholder={folder ? "Ask something… (Enter to send)" : "Choose a folder first"}
                  disabled={!folder}
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
                  {busy ? (
                    <InputGroupButton
                      size="icon-sm"
                      variant="default"
                      className="ml-auto rounded-full"
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
                      className="ml-auto rounded-full"
                      disabled={!folder || !input.trim()}
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
