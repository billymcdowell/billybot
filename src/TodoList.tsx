import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, ListChecksIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { allDone, type Todo } from "./todos";

type Props = {
  items: Todo[];
  /** Clearing is only offered while the agent isn't working. */
  canClear: boolean;
  onClear: () => void;
};

/** The agent's to-do list for a long task, above the message box. Folds to a single line when everything is done. */
export default function TodoList({ items, canClear, onClear }: Props) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "completed").length;
  const finished = allDone(items);
  const current = items.find((t) => t.status === "in_progress");
  const expanded = open && !finished;

  return (
    <div className="rounded-lg border bg-muted/30 text-sm" aria-label="The agent's to-do list">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
          aria-expanded={expanded}
          disabled={finished}
        >
          <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">
            {finished ? `All ${items.length} steps done` : `${done} of ${items.length} done`}
          </span>
          {!expanded && current && <span className="truncate text-muted-foreground">· {current.content}</span>}
          {!finished && <ChevronDownIcon className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />}
        </button>
        {canClear && (
          <Button size="icon-xs" variant="ghost" onClick={onClear} aria-label="Clear the to-do list" title="Clear the to-do list">
            <XIcon />
          </Button>
        )}
      </div>
      {expanded && (
        <ul className="flex flex-col gap-1 px-3 pb-3">
          {items.map((t, i) => (
            <li key={i} className={cn("flex items-start gap-2", t.status === "completed" && "text-muted-foreground")}>
              <span className="mt-0.5 shrink-0">
                {t.status === "completed" ? (
                  <CheckCircle2Icon className="size-4 text-green-600" aria-label="Done" />
                ) : t.status === "in_progress" ? (
                  <Spinner className="size-4" aria-label="Working on this" />
                ) : (
                  <CircleIcon className="size-4 text-muted-foreground" aria-label="Not started" />
                )}
              </span>
              <span className={cn(t.status === "completed" && "line-through", t.status === "in_progress" && "font-medium")}>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
