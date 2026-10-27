import { cn } from "@/lib/utils";
import { collapseDiff, diffLines } from "./diff";

type Props = {
  before: string;
  after: string;
  isNew?: boolean; // the file doesn't exist yet
};

/** Added and removed lines, with a little unchanged context around each change. */
export default function DiffView({ before, after, isNew }: Props) {
  const lines = diffLines(before, after);
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;

  if (added === 0 && removed === 0) {
    return <p className="text-xs text-muted-foreground">No changes: the new text is the same as the old.</p>;
  }

  return (
    <div className="w-full overflow-hidden rounded-md border text-xs">
      <div className="flex gap-2 border-b bg-muted/50 px-2 py-1 text-muted-foreground">
        {isNew && <span>New file</span>}
        <span className="text-green-600 dark:text-green-400">+{added}</span>
        <span className="text-red-600 dark:text-red-400">−{removed}</span>
      </div>
      <pre className="max-h-64 overflow-auto py-1 font-mono leading-5">
        {collapseDiff(lines).map((row, i) =>
          row.kind === "gap" ? (
            <div key={i} className="bg-muted/30 px-2 text-muted-foreground">
              ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "px-2",
                row.kind === "add" && "bg-green-500/15 text-green-700 dark:text-green-300",
                row.kind === "del" && "bg-red-500/15 text-red-700 dark:text-red-300",
              )}
            >
              <span className="select-none opacity-60">{row.kind === "add" ? "+ " : row.kind === "del" ? "− " : "  "}</span>
              {row.text || " "}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
