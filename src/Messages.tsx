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
  ListIcon,
  WrenchIcon,
} from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
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
import type { SubagentRun } from "./storage";

type Msg = ChatCompletionMessageParam;
type Call = { id: string; name: string; args: Record<string, unknown> };

// Icon and wording for each tool, so a line reads like "Read web/index.html".
const TOOLS: Record<string, { icon: ElementType; done: string; running: string }> = {
  list_dir: { icon: FolderTreeIcon, done: "Listed", running: "Listing" },
  read_file: { icon: FileTextIcon, done: "Read", running: "Reading" },
  write_file: { icon: FilePenIcon, done: "Wrote", running: "Writing" },
  list_projects: { icon: ListIcon, done: "Listed projects", running: "Listing projects" },
  open_project: { icon: FolderOpenIcon, done: "Opened", running: "Opening" },
  close_project: { icon: FolderXIcon, done: "Closed", running: "Closing" },
  create_project: { icon: FolderPlusIcon, done: "Created", running: "Creating" },
};

// Results the agent writes when a tool didn't do what was asked.
const isFailure = (result: string) =>
  /^(Error:|Refused:|Could not|Read-only mode|The user denied)/.test(result);

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

/** The Tool pattern: one Trace line per call; open it to see the output. */
function ToolLine({ call, result }: { call: Call; result?: string }) {
  const tool = TOOLS[call.name] ?? { icon: WrenchIcon, done: `Ran ${call.name}`, running: `Running ${call.name}` };
  const Icon = tool.icon;
  const target = String(call.args.path ?? call.args.name ?? "");
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
        {run.report && <p className="whitespace-pre-wrap">{run.report}</p>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

type Props = {
  messages: Msg[];
  streaming: string; // text of the reply as it streams in
  subagents?: Record<string, SubagentRun>;
};

/** The Chat pattern: a scrolling thread of Message turns that follows new output. */
export default function MessageList({ messages, streaming, subagents = {} }: Props) {
  const results = resultsOf(messages);
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 p-4">
            {messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <MessageScrollerItem key={i} messageId={String(i)} scrollAnchor>
                    <Message align="end">
                      <MessageContent>
                        <Bubble align="end" variant="muted">
                          <BubbleContent className="whitespace-pre-wrap">{textOf(m.content)}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                );
              }
              if (m.role !== "assistant") return null; // tool results show inside their Trace line
              const calls = callsOf(m);
              return (
                <MessageScrollerItem key={i} messageId={String(i)}>
                  <Message>
                    <MessageContent className="gap-2">
                      {textOf(m.content) && <p className="whitespace-pre-wrap">{textOf(m.content)}</p>}
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
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
            {streaming && (
              <MessageScrollerItem messageId="streaming">
                <Message>
                  <MessageContent>
                    <p className="whitespace-pre-wrap">{streaming}</p>
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
