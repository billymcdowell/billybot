import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_LIMITS, LIMIT_BOUNDS, resolveLimits, type Limits } from "./limits";

const FIELDS: { key: keyof Limits; label: string; unit: string }[] = [
  { key: "defaultTimeoutSecs", label: "Command time limit", unit: "seconds" },
  { key: "maxTimeoutSecs", label: "Longest the agent may ask for", unit: "seconds" },
  { key: "outputHeadChars", label: "Command output: keep the start", unit: "characters" },
  { key: "outputTailChars", label: "Command output: keep the end", unit: "characters" },
  { key: "maxResultChars", label: "Largest tool result", unit: "characters" },
  { key: "budgetUsd", label: "Budget for each chat (0 = none)", unit: "dollars" },
  { key: "compactAtPercent", label: "Summarize old messages when the chat is this full", unit: "% of window" },
  { key: "maxConcurrentRuns", label: "Chats that may work at once", unit: "chats" },
  { key: "checkpointDays", label: "Keep undo copies for", unit: "days" },
  { key: "checkpointMb", label: "Undo copies may take up to", unit: "MB" },
];

const THEMES = [
  { id: "system", label: "System", icon: MonitorIcon },
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  polish: boolean;
  onPolishChange: (on: boolean) => void;
  limits: Limits;
  onChange: (limits: Limits) => void;
  redact: boolean;
  onRedactChange: (on: boolean) => void;
  branchPerChat: boolean;
  onBranchPerChatChange: (on: boolean) => void;
  notifyOn: boolean;
  onNotifyChange: (on: boolean) => void;
  autoCompact: boolean;
  onAutoCompactChange: (on: boolean) => void;
};

/** Global settings: appearance, dictation and the limits in src/limits.ts. A limit is applied (and clamped) when you leave its box. */
export default function SettingsDialog({ open, onOpenChange, polish, onPolishChange, limits, onChange, redact, onRedactChange, branchPerChat, onBranchPerChatChange, notifyOn, onNotifyChange, autoCompact, onAutoCompactChange }: Props) {
  const { theme = "system", setTheme } = useTheme();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Longer results use more of the model's context. Changes apply from the next message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label>Theme</Label>
            <ToggleGroup type="single" variant="outline" size="sm" value={theme} onValueChange={(v) => v && setTheme(v)}>
              {THEMES.map(({ id, label, icon: Icon }) => (
                <ToggleGroupItem key={id} value={id} aria-label={label}>
                  <Icon /> {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex items-start gap-3">
            <Switch id="polish" checked={polish} onCheckedChange={onPolishChange} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="polish">Polish dictation</Label>
              <span className="text-xs text-muted-foreground">A quick model pass tidies up what you dictate before it is sent.</span>
            </div>
          </div>
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
          <div className="flex items-start gap-3">
            <Switch id="redact" checked={redact} onCheckedChange={onRedactChange} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="redact">Hide secrets from the model</Label>
              <span className="text-xs text-muted-foreground">
                Keys, tokens and passwords in files and command output are replaced with a placeholder before the model sees them.
                It catches common formats, not everything.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch id="compact" checked={autoCompact} onCheckedChange={onAutoCompactChange} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="compact">Summarize old messages automatically</Label>
              <span className="text-xs text-muted-foreground">
                When a chat fills the model's window, the oldest messages are replaced, for the model only, by a summary. Every message stays on
                screen. It costs one extra model call, counted in the chat's cost.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch id="notify" checked={notifyOn} onCheckedChange={onNotifyChange} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="notify">Notify me when a chat finishes or needs me</Label>
              <span className="text-xs text-muted-foreground">
                A desktop notification, only while billybot is in the background. The sidebar always shows it.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch id="branch" checked={branchPerChat} onCheckedChange={onBranchPerChatChange} />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="branch">Give each chat its own git branch</Label>
              <span className="text-xs text-muted-foreground">
                Before the agent's first change to a git project, a branch like billybot/fix-login-1a2b is made. Skipped if the project has
                uncommitted changes. Nothing is stashed, discarded or pushed.
              </span>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => onChange({ ...DEFAULT_LIMITS })}>
            Reset to defaults
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
