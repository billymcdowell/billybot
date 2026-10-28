import {
  AlertCircleIcon, ArrowDownIcon, BotIcon, CopyIcon, CpuIcon, DownloadIcon, MessageSquareIcon, PlayIcon,
  ShieldCheckIcon, TerminalIcon, Trash2Icon, WrenchIcon, XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ElementType, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatTokens } from "./context";
import { formatCost } from "./cost";
import {
  activityStats, filterEvents, FILTERS, formatDuration, type ActivityCategory, type ActivityEvent, type Filter,
} from "./activity";

const ICONS: Record<ActivityCategory, ElementType> = {
  run: PlayIcon, request: CpuIcon, tool: WrenchIcon, command: TerminalIcon, approval: ShieldCheckIcon,
  subagent: BotIcon, chat: MessageSquareIcon, error: AlertCircleIcon,
};

export const MIN_WIDTH = 300;
export const MAX_WIDTH = 760;

type Props = {
  events: ActivityEvent[];
  width: number;
  onWidthChange: (width: number, final: boolean) => void;
  onClose: () => void;
  onClear: () => void;
  onExport: (visible: ActivityEvent[]) => void;
};

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

/** A live log of everything the app and the agent are doing, docked on the right. */
export default function ActivityPanel({ events, width, onWidthChange, onClose, onClear, onExport }: Props) {
  const [active, setActive] = useState<Set<Filter>>(new Set());
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const visible = useMemo(() => filterEvents(events, active, query), [events, active, query]);
  const stats = useMemo(() => activityStats(events), [events]);

  // Stay at the newest row while you're looking at it; leave you alone once you scroll up.
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    following.current = near;
    setAtBottom(near);
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    following.current = true;
    setAtBottom(true);
  }

  const toggleFilter = (f: Filter) =>
    setActive((s) => {
      const next = new Set(s);
      if (!next.delete(f)) next.add(f);
      return next;
    });
  const toggleRow = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Drag the left edge to resize.
  function startResize(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const clamp = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
    const move = (ev: globalThis.PointerEvent) => onWidthChange(clamp(startWidth + (startX - ev.clientX)), false);
    const up = (ev: globalThis.PointerEvent) => {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      onWidthChange(clamp(startWidth + (startX - ev.clientX)), true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});
  const line = (e: ActivityEvent) => `${clock(e.time)} ${e.who} ${e.summary}${e.durationMs !== undefined ? ` (${formatDuration(e.durationMs)})` : ""}`;

  return (
    <aside className="relative flex h-svh shrink-0 flex-col border-l bg-background" style={{ width }} aria-label="Activity log">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the activity panel"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20"
      />

      <header className="flex items-center gap-1 border-b px-3 py-2">
        <h2 className="flex-1 text-sm font-medium">Activity</h2>
        <Button size="icon-xs" variant="ghost" aria-label="Copy the rows shown" title="Copy the rows shown" disabled={!visible.length} onClick={() => copy(visible.map(line).join("\n"))}>
          <CopyIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Save the rows shown as JSON" title="Save the rows shown as JSON" disabled={!visible.length} onClick={() => onExport(visible)}>
          <DownloadIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Clear the view" title="Clear this view (the saved log is kept)" disabled={!events.length} onClick={onClear}>
          <Trash2Icon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close the activity panel" onClick={onClose}>
          <XIcon />
        </Button>
      </header>

      <div className="flex flex-col gap-2 border-b px-3 py-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the log" aria-label="Search the log" className="h-8" />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button key={f.id} size="xs" variant={active.has(f.id) ? "default" : "outline"} aria-pressed={active.has(f.id)} onClick={() => toggleFilter(f.id)}>
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {events.length === 0
              ? "Nothing yet. Requests, tool calls, approvals and errors show up here as they happen."
              : "No rows match the filter or search."}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((e) => {
              const Icon = ICONS[e.category];
              const expanded = open.has(e.id);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => toggleRow(e.id)}
                    aria-expanded={expanded}
                    className="flex w-full items-start gap-2 py-1.5 pr-3 text-left text-xs hover:bg-muted/50"
                    style={{ paddingLeft: 12 + e.depth * 14 }}
                  >
                    <span className="mt-px shrink-0 tabular-nums text-muted-foreground">{clock(e.time)}</span>
                    <Icon
                      className={cn("mt-px size-3.5 shrink-0", e.level === "error" ? "text-red-500" : e.level === "warn" ? "text-amber-500" : "text-muted-foreground")}
                      aria-hidden
                    />
                    <span className={cn("min-w-0 flex-1 break-words", e.level === "error" && "text-red-600 dark:text-red-400", e.level === "warn" && "text-amber-700 dark:text-amber-400")}>
                      {e.depth > 0 && <span className="text-muted-foreground">{e.who}: </span>}
                      {e.summary}
                    </span>
                    <span className="mt-px shrink-0 text-muted-foreground">
                      {e.pending ? <Spinner className="size-3" /> : e.durationMs !== undefined ? formatDuration(e.durationMs) : ""}
                    </span>
                  </button>
                  {expanded && (
                    <div className="space-y-1 bg-muted/30 py-2 pr-3 text-xs" style={{ paddingLeft: 12 + e.depth * 14 }}>
                      <p className="text-muted-foreground">
                        {e.who} · {e.category} · {new Date(e.time).toLocaleString()}
                      </p>
                      {e.detail ? (
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono">
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-muted-foreground">No more detail.</p>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => copy(`${line(e)}\n${e.detail ? JSON.stringify(e.detail, null, 2) : ""}`)}>
                        <CopyIcon /> Copy
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!atBottom && visible.length > 0 && (
          <Button size="xs" variant="secondary" className="sticky bottom-2 left-1/2 -translate-x-1/2 shadow" onClick={jumpToLatest}>
            <ArrowDownIcon /> Jump to latest
          </Button>
        )}
      </div>

      <footer className="flex flex-wrap gap-x-3 gap-y-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>{formatDuration(stats.elapsedMs)}</span>
        <span>{stats.requests} {stats.requests === 1 ? "request" : "requests"}</span>
        <span>{stats.toolCalls} tool {stats.toolCalls === 1 ? "call" : "calls"}</span>
        <span>{formatTokens(stats.inputTokens)} in / {formatTokens(stats.outputTokens)} out</span>
        {stats.cost > 0 && <span>{formatCost(stats.cost)}</span>}
        {stats.problems > 0 && <span className="text-amber-600 dark:text-amber-400">{stats.problems} {stats.problems === 1 ? "problem" : "problems"}</span>}
      </footer>
    </aside>
  );
}
