import { useEffect, useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchToolModels, formatContext, formatPrice, type ModelInfo } from "./models";

type Props = {
  apiKey: string;
  value: string; // the selected model ID
  onChange: (id: string) => void;
  disabled?: boolean;
};

/** The Model Selector pattern: a menu button in the prompt box, with search for OpenRouter's long list. */
export default function ModelPicker({ apiKey, value, onChange, disabled }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  async function load(refresh = false) {
    setLoading(true);
    setError("");
    try {
      setModels(await fetchToolModels(apiKey, refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [apiKey]);

  // Group by provider ("anthropic/claude-…" → "anthropic"), keeping the popularity order.
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const provider = m.id.split("/")[0];
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), m]);
    }
    return [...byProvider.entries()];
  }, [models]);

  const current = models.find((m) => m.id === value);
  const typed = query.trim();
  // Lets you paste any model ID, even one missing from the list.
  const canUseTyped = typed.includes("/") && !models.some((m) => m.id === typed);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton size="sm" disabled={disabled} title={value}>
          <span className="max-w-40 truncate">{current ? current.name : value}</span>
          <ChevronDownIcon />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Search models, or paste an ID…" value={query} onValueChange={setQuery} />
          <CommandList>
            {loading && <p className="p-3 text-sm text-muted-foreground">Loading models…</p>}
            {error && <p className="p-3 text-sm text-destructive">{error}</p>}
            <CommandEmpty>No tool-capable models match.</CommandEmpty>
            {canUseTyped && (
              <CommandGroup heading="Custom">
                <CommandItem value={typed} onSelect={() => choose(typed)}>
                  Use “{typed}”
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map(([provider, list]) => (
              <CommandGroup key={provider} heading={provider}>
                {list.map((m) => (
                  <CommandItem key={m.id} value={`${m.name} ${m.id}`} onSelect={() => choose(m.id)}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{m.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {formatPrice(m)}
                        {formatContext(m.contextLength) && ` · ${formatContext(m.contextLength)}`}
                      </span>
                    </div>
                    {m.id === value && <CheckIcon className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <div className="border-t p-1">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => load(true)} disabled={loading}>
            <RefreshCwIcon />
            Reload list
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
