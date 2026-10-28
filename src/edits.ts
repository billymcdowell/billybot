// The same all-or-nothing edit rules as multi_edit in Rust, so the approval card can show the
// file as it will look after the edits.

export type TextEdit = { old_text: string; new_text: string };

const MAX_EDITS = 100;

/** Checks the model's `edits` argument. Throws an error the model can act on. */
export function parseEdits(raw: unknown): TextEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("edits must be a non-empty list of {old_text, new_text}.");
  if (raw.length > MAX_EDITS) throw new Error(`At most ${MAX_EDITS} edits at a time. Split them up.`);
  return raw.map((e, i) => {
    if (!e || typeof e.old_text !== "string" || typeof e.new_text !== "string") {
      throw new Error(`Edit ${i + 1} of ${raw.length} must have old_text and new_text as text.`);
    }
    return { old_text: e.old_text, new_text: e.new_text };
  });
}

/** Applies the edits in order, each to the result of the one before. Each must match exactly once. */
export function applyEdits(content: string, edits: TextEdit[]): string {
  let text = content;
  edits.forEach((e, i) => {
    const at = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : "";
    if (e.old_text === "") throw new Error(`${at}old_text must not be empty.`);
    const count = text.split(e.old_text).length - 1;
    if (count === 0) throw new Error(`${at}old_text was not found.`);
    if (count > 1) throw new Error(`${at}old_text appears ${count} times.`);
    const idx = text.indexOf(e.old_text);
    text = text.slice(0, idx) + e.new_text + text.slice(idx + e.old_text.length);
  });
  return text;
}
