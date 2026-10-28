import DiffView from "./DiffView";
import { applyEdits, parseEdits } from "./edits";

/** The approval preview for multi_edit: the whole file before and after, or each edit if they don't apply. */
export default function MultiEditDiff({ before, rawEdits }: { before: string | null | undefined; rawEdits: unknown }) {
  let edits;
  try {
    edits = parseEdits(rawEdits);
  } catch (e) {
    return <p className="text-xs text-muted-foreground">{e instanceof Error ? e.message : String(e)}</p>;
  }
  if (typeof before === "string") {
    try {
      return <DiffView before={before} after={applyEdits(before, edits)} />;
    } catch (e) {
      // Fall through to the edit-by-edit view, and say why.
      return (
        <div className="flex w-full flex-col gap-2">
          <p className="text-xs text-destructive">These edits won't apply cleanly: {e instanceof Error ? e.message : String(e)}</p>
          {edits.map((edit, i) => (
            <DiffView key={i} before={edit.old_text} after={edit.new_text} />
          ))}
        </div>
      );
    }
  }
  return (
    <div className="flex w-full flex-col gap-2">
      {edits.map((edit, i) => (
        <DiffView key={i} before={edit.old_text} after={edit.new_text} />
      ))}
    </div>
  );
}
