import { Button } from "@/components/ui/button";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextBreakdown, type ContextPart } from "./context";

type Props = {
  breakdown: ContextBreakdown;
  lastRequest: { promptTokens: number; completionTokens: number } | null; // exact, from the API
  compacted: { tokensBefore?: number; tokensAfter?: number } | null; // set when older messages are shown to the model as a summary
  canCompact: boolean;
  onCompact: () => void;
};

const COLORS: Record<ContextPart["id"], string> = {
  messages: "bg-blue-500",
  results: "bg-orange-500",
  system: "bg-amber-500",
  instructions: "bg-violet-500",
  tools: "bg-emerald-500",
  free: "bg-muted-foreground/25",
};

const percent = (n: number, of: number) => (of > 0 ? (n / of) * 100 : 0);
const shown = (p: number) => (p >= 10 || p === 0 ? Math.round(p) : Number(p.toFixed(1)));

/** A small ring in the prompt bar that opens a breakdown of what fills the model's context. */
export default function ContextMeter({ breakdown, lastRequest, compacted, canCompact, onCompact }: Props) {
  const { parts, used, window, free } = breakdown;
  const usedPct = window ? percent(used, window) : null;
  const barTotal = window ?? used; // without a known window, the bar shows only the split of what's used
  const tone = usedPct === null ? "text-muted-foreground" : usedPct >= 90 ? "text-red-500" : usedPct >= 70 ? "text-amber-500" : "";

  // The ring: a circle whose stroke is drawn for the used share.
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(100, usedPct ?? 0) / 100;

  const rows: (ContextPart | { id: "free"; label: string; tokens: number })[] = [...parts];
  if (free !== null) rows.push({ id: "free", label: "Free space", tokens: free });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <InputGroupButton size="sm" title="Context window usage" aria-label="Context window usage">
          <svg width="16" height="16" viewBox="0 0 16 16" className={cn("-rotate-90", tone)} aria-hidden>
            <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${circumference * filled} ${circumference}`}
            />
          </svg>
          <span className={tone}>{usedPct === null ? formatTokens(used) : `${shown(usedPct)}%`}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3">
        <div className="text-sm font-medium">Context</div>

        <div className="flex items-baseline justify-between">
          <span className={cn("text-lg font-medium", tone)}>
            {usedPct === null ? `${formatTokens(used)} used` : `${shown(usedPct)}% used`}
          </span>
          <span className="text-sm text-muted-foreground">
            {window ? `≈${formatTokens(used)} / ${formatTokens(window)}` : "window size unknown"}
          </span>
        </div>

        <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label="Context usage by category">
          {parts.map((p) => (
            <div key={p.id} className={COLORS[p.id]} style={{ width: `${percent(p.tokens, barTotal)}%` }} />
          ))}
        </div>

        <ul className="flex flex-col gap-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className={cn("size-3 shrink-0 rounded-[3px]", COLORS[r.id])} />
              <span className="flex-1">{r.label}</span>
              <span className="tabular-nums text-muted-foreground">{formatTokens(r.tokens)}</span>
              <span className="w-12 text-right tabular-nums">
                {window ? `${shown(percent(r.tokens, window))}%` : `${shown(percent(r.tokens, used))}%`}
              </span>
            </li>
          ))}
        </ul>

        {usedPct !== null && usedPct >= 80 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This conversation is getting full. Start a new chat before the model begins to lose track or errors out.
          </p>
        )}

        <div className="flex flex-col gap-2 border-t pt-2 text-xs text-muted-foreground">
          {compacted && (
            <p>
              Older messages are shown to the model as a summary
              {compacted.tokensBefore && compacted.tokensAfter
                ? ` (about ${compacted.tokensAfter.toLocaleString("en-US")} tokens instead of ${compacted.tokensBefore.toLocaleString("en-US")})`
                : ""}
              . They stay on screen.
            </p>
          )}
          <Button size="xs" variant="outline" disabled={!canCompact} onClick={onCompact} title="Replace the oldest messages, for the model, with a summary. You can also type /compact.">
            Summarize earlier messages
          </Button>
        </div>

        <div className="flex flex-col gap-1 border-t pt-2 text-xs text-muted-foreground">
          {lastRequest ? (
            <p>
              Last request, as reported by OpenRouter: {lastRequest.promptTokens.toLocaleString()} in,{" "}
              {lastRequest.completionTokens.toLocaleString()} out.
            </p>
          ) : (
            <p>Exact counts from OpenRouter appear after the first reply.</p>
          )}
          <p>The split is estimated at about 4 characters per token. It covers the main agent; subagents have their own context.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
