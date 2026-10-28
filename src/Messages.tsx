import type { ElementType } from "react";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  BotIcon,
  FilePenIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  FolderXIcon,
  GitForkIcon,
  Undo2Icon,
  ListIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Textarea } from "@/components/ui/textarea";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { textOf } from "./agent";
import Markdown from "./Markdown";
import { formatCost } from "./cost";
import type { SubagentRun } from "./storage";

type Msg = ChatCompletionMessageParam;
type Call = { id: string; name: string; args: Record<string, unknown> };

// Icon and wording for each tool, so a line reads like "Read web/index.html".
const TOOLS: Record<string, { icon: ElementType; done: string; running: string }> = {
  list_dir: { icon: FolderTreeIcon, done: "Listed", running: "Listing" },
  read_file: { icon: FileTextIcon, done: "Read", running: "Reading" },
  write_file: { icon: FilePenIcon, done: "Wrote", running: "Writing" },
  edit_file: { icon: FilePenIcon, done: "Edited", running: "Editing" },
  multi_edit: { icon: FilePenIcon, done: "Edited", running: "Editing" },
  grep: { icon: SearchIcon, done: "Searched", running: "Searching" },
  glob: { icon: SearchIcon, done: "Found files in", running: "Finding files in" },
  run_command: { icon: TerminalIcon, done: "Ran", running: "Running" },
  list_projects: { icon: ListIcon, done: "Listed projects", running: "Listing projects" },
  open_project: { icon: FolderOpenIcon, done: "Opened", running: "Opening" },
  close_project: { icon: FolderXIcon, done: "Closed", running: "Closing" },
  create_project: { icon: FolderPlusIcon, done: "Created", running: "Creating" },
};

// Results the agent writes when a tool didn't do what was asked.
const isFailure = (result: string) =>
  /^(Error:|Refused:|Could not|Read-only mode|The user denied|Timed out|Cancelled|Exit code (?!0\b))/.test(result);

function callsOf(m: Msg): Call[] {
  if (m.role !== "assistant" || !m.tool_calls) return [];
  return m.tool_calls.flatMap((tc) => {
    if (tc.type !== "function") return [];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      // half-streamed or invalid JSON: show the call without its arguments
    }
    return [{ id: tc.id, name: tc.function.name, args }];
  });
}

/** tool_call_id → the tool's result text */
function resultsOf(messages: Msg[]) {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, textOf(m.content));
  return results;
}

/** What a call acted on, for its line: a path, a project name, a command, or a search and where. */
function targetOf(call: Call) {
  const { path, name, command, pattern } = call.args;
  if (call.name === "grep" || call.name === "glob") return `${String(path ?? "")} for ${String(pattern ?? "")}`;
  return String(path ?? name ?? command ?? "");
}

/** The Tool pattern: one Trace line per call; open it to see the output. */
function ToolLine({ call, result }: { call: Call; result?: string }) {
  const tool = TOOLS[call.name] ?? { icon: WrenchIcon, done: `Ran ${call.name}`, running: `Running ${call.name}` };
  const Icon = tool.icon;
  const target = targetOf(call);
  const failed = result !== undefined && isFailure(result);
  const title =
    result === undefined ? `${tool.running} ${target}…` : `${failed ? "Failed: " : ""}${tool.done} ${target}`;
  const line = (
    <TraceLine status={result === undefined ? "running" : failed ? "error" : undefined}>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>{title.trim()}</TraceTitle>
    </TraceLine>
  );
  if (!result) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
          <CodeBlockContent wrap className="max-h-64">
            {result}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Every tool call in a conversation, as Trace lines. */
function ToolCalls({ messages }: { messages: Msg[] }) {
  const results = resultsOf(messages);
  const calls = messages.flatMap(callsOf);
  if (calls.length === 0) return null;
  return (
    <Trace>
      {calls.map((c) => (
        <ToolLine key={c.id} call={c} result={results.get(c.id)} />
      ))}
    </Trace>
  );
}

/** The Subagent pattern: one line for the run; open it for the task, its tool calls and its report. */
function SubagentLine({ run }: { run: SubagentRun }) {
  const count = run.messages.flatMap(callsOf).length;
  const title =
    run.status === "running"
      ? `Running the ${run.project} agent`
      : run.status === "done"
        ? `Ran the ${run.project} agent`
        : `The ${run.project} agent ${run.status}`;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={run.status === "running" ? "running" : run.status === "done" ? undefined : "error"}>
          <TraceIcon>
            <BotIcon />
          </TraceIcon>
          <TraceTitle>{title}</TraceTitle>
          <TraceDescription>{count} tool calls</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-3">
        <p className="text-muted-foreground">{run.task}</p>
        <ToolCalls messages={run.messages} />
        {run.report && <Markdown>{run.report}</Markdown>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export type EditingMessage = { index: number; text: string };

type Props = {
  messages: Msg[];
  streaming: string; // text of the reply as it streams in
  subagents?: Record<string, SubagentRun>;
  turnCosts?: Record<string, number>; // dollars per turn, keyed by the index of the turn's user message
  changedTurns?: Record<string, number>; // files each turn changed, which can be undone
  onRevert?: (turn: number) => void;
  busy?: boolean; // hides the per-message actions while the agent works
  onFork?: (index: number) => void;
  onEdit?: (index: number) => void;
  editing?: EditingMessage | null;
  onEditChange?: (text: string) => void;
  onEditCancel?: () => void;
  onEditSubmit?: () => void;
};

/** Small buttons that appear when you hover (or focus) a message. */
const actionsClass =
  "flex gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100";

/** The Chat pattern: a scrolling thread of Message turns that follows new output. */
export default function MessageList({
  messages,
  streaming,
  subagents = {},
  turnCosts = {},
  changedTurns = {},
  onRevert,
  busy = false,
  onFork,
  onEdit,
  editing,
  onEditChange,
  onEditCancel,
  onEditSubmit,
}: Props) {
  const results = resultsOf(messages);
  let turn = -1; // index of the user message that started the turn being drawn
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 p-4">
            {messages.map((m, i) => {
              if (m.role === "user") {
                turn = i;
                const isEditing = editing?.index === i;
                return (
                  <MessageScrollerItem key={i} messageId={String(i)} scrollAnchor>
                    <Message align="end">
                      <MessageContent className="group/msg items-end">
                        {isEditing ? (
                          <div className="flex w-full flex-col gap-2">
                            <Textarea
                              autoFocus
                              rows={3}
                              value={editing.text}
                              aria-label="Edit your message"
                              onChange={(e) => onEditChange?.(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onEditSubmit?.();
                                if (e.key === "Escape") onEditCancel?.();
                              }}
                            />
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={onEditCancel}>
                                Cancel
                              </Button>
                              <Button size="sm" onClick={onEditSubmit} disabled={!editing.text.trim()}>
                                Resend
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">{textOf(m.content)}</BubbleContent>
                            </Bubble>
                            {!busy && (onEdit || onFork) && (
                              <div className={actionsClass}>
                                {onEdit && (
                                  <Button size="xs" variant="ghost" onClick={() => onEdit(i)}>
                                    <PencilIcon /> Edit
                                  </Button>
                                )}
                                {onFork && (
                                  <Button size="xs" variant="ghost" onClick={() => onFork(i)}>
                                    <GitForkIcon /> Fork
                                  </Button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                );
              }
              if (m.role !== "assistant") return null; // tool results show inside their Trace line
              const calls = callsOf(m);
              const next = messages[i + 1];
              const endsTurn = !next || next.role === "user"; // the last thing the agent said before you spoke again
              const cost = turnCosts[String(turn)];
              const thisTurn = turn; // `turn` moves on as the loop continues; a click happens later
              const changedFiles = changedTurns[String(thisTurn)] ?? 0;
              return (
                <MessageScrollerItem key={i} messageId={String(i)}>
                  <Message>
                    <MessageContent className="group/msg gap-2">
                      {textOf(m.content) && <Markdown>{textOf(m.content)}</Markdown>}
                      {calls.length > 0 && (
                        <Trace>
                          {calls.map((c) =>
                            subagents[c.id] ? (
                              <SubagentLine key={c.id} run={subagents[c.id]} />
                            ) : (
                              <ToolLine key={c.id} call={c} result={results.get(c.id)} />
                            ),
                          )}
                        </Trace>
                      )}
                      {endsTurn && !busy && (cost !== undefined || onFork || changedFiles > 0) && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {cost !== undefined && <span title="What this turn cost">{formatCost(cost)}</span>}
                          {changedFiles > 0 && onRevert && (
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-foreground"
                              onClick={() => onRevert(thisTurn)}
                              title="Put the files this reply changed back as they were"
                            >
                              <Undo2Icon /> Undo {changedFiles} {changedFiles === 1 ? "file" : "files"}
                            </Button>
                          )}
                          {onFork && (
                            <div className={actionsClass}>
                              <Button size="xs" variant="ghost" onClick={() => onFork(i)}>
                                <GitForkIcon /> Fork from here
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
            {streaming && (
              <MessageScrollerItem messageId="streaming">
                <Message>
                  <MessageContent>
                    <Markdown>{streaming}</Markdown>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
