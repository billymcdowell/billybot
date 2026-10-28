import { SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { DEFAULT_LIMITS, LIMIT_BOUNDS, resolveLimits, type Limits } from "./limits";

const FIELDS: { key: keyof Limits; label: string; unit: string }[] = [
  { key: "defaultTimeoutSecs", label: "Command time limit", unit: "seconds" },
  { key: "maxTimeoutSecs", label: "Longest the agent may ask for", unit: "seconds" },
  { key: "outputHeadChars", label: "Command output: keep the start", unit: "characters" },
  { key: "outputTailChars", label: "Command output: keep the end", unit: "characters" },
  { key: "maxResultChars", label: "Largest tool result", unit: "characters" },
  { key: "budgetUsd", label: "Budget for each chat (0 = none)", unit: "dollars" },
];

type Props = { limits: Limits; onChange: (limits: Limits) => void };

/** Header menu for the limits in src/limits.ts. A value is applied (and clamped) when you leave its box. */
export default function LimitsPopover({ limits, onChange }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [limits]);

  function commit(key: keyof Limits) {
    const text = draft[key];
    if (text === undefined) return;
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) return setDraft({});
    onChange(resolveLimits({ ...limits, [key]: n }));
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon-xs" variant="outline" aria-label="Limits" title="Limits">
          <SlidersHorizontalIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Limits</PopoverTitle>
          <PopoverDescription>
            Longer results use more of the model's context. Changes apply from the next message.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          {FIELDS.map(({ key, label, unit }) => (
            <div key={key} className="flex flex-col gap-1">
              <Label htmlFor={`limit-${key}`}>{label}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`limit-${key}`}
                  inputMode="decimal"
                  value={draft[key] ?? String(limits[key])}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  onBlur={() => commit(key)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{unit}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {LIMIT_BOUNDS[key][0].toLocaleString("en-US")} to {LIMIT_BOUNDS[key][1].toLocaleString("en-US")}
              </span>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => onChange({ ...DEFAULT_LIMITS })}>
            Reset to defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
