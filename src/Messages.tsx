import type { ElementType } from "react";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { FilePenIcon, FileTextIcon, FolderTreeIcon, WrenchIcon } from "lucide-react";
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
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

type Msg = ChatCompletionMessageParam;
type Call = { id: string; name: string; args: Record<string, unknown> };

/** Message content can be a string or a list of parts; this returns the text. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === "text" ? p.text : "")).join("");
  }
  return "";
}

// Icon and wording for each tool, so a line reads like "Read src/App.tsx".
const TOOLS: Record<string, { icon: ElementType; done: string; running: string }> = {
  list_dir: { icon: FolderTreeIcon, done: "Listed", running: "Listing" },
  read_file: { icon: FileTextIcon, done: "Read", running: "Reading" },
  write_file: { icon: FilePenIcon, done: "Wrote", running: "Writing" },
};

// Results the agent writes when a tool didn't do what was asked.
const isFailure = (result: string) => /^(Error:|Read-only mode|The user denied)/.test(result);

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

/** The Tool pattern: one Trace line per call; open it to see the output. */
function ToolLine({ call, result }: { call: Call; result?: string }) {
  const tool = TOOLS[call.name] ?? { icon: WrenchIcon, done: `Ran ${call.name}`, running: `Running ${call.name}` };
  const Icon = tool.icon;
  const target = String(call.args.path ?? "");
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

type Props = {
  messages: Msg[];
  streaming: string; // text of the reply as it streams in
};

/** The Chat pattern: a scrolling thread of Message turns that follows new output. */
export default function MessageList({ messages, streaming }: Props) {
  // tool_call_id → the tool's result text
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, textOf(m.content));

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
                          {calls.map((c) => (
                            <ToolLine key={c.id} call={c} result={results.get(c.id)} />
                          ))}
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
