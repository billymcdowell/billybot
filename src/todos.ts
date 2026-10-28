// The agent's to-do list for a long task. It writes the whole list each time (simple, and hard to
// get out of step), and you see it above the message box.

export type TodoStatus = "pending" | "in_progress" | "completed";
export type Todo = { content: string; status: TodoStatus };

const MAX_TODOS = 30;
const MAX_LENGTH = 200;
const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** Checks the model's `items` argument. Throws an error the model can act on. */
export function parseTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) throw new Error("items must be a list of {content, status}.");
  if (raw.length > MAX_TODOS) throw new Error(`At most ${MAX_TODOS} items. Group small steps together.`);
  const items = raw.map((item, i) => {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!content) throw new Error(`Item ${i + 1} needs some content.`);
    if (content.length > MAX_LENGTH) throw new Error(`Item ${i + 1} is longer than ${MAX_LENGTH} characters. Keep each item short.`);
    if (!STATUSES.has(item.status)) throw new Error(`Item ${i + 1} has the status "${String(item.status)}". Use pending, in_progress or completed.`);
    return { content, status: item.status as TodoStatus };
  });
  if (items.filter((t) => t.status === "in_progress").length > 1) {
    throw new Error("Only one item can be in_progress at a time. Finish one before starting the next.");
  }
  return items;
}

export function summarizeTodos(items: Todo[]): string {
  if (items.length === 0) return "Todo list cleared.";
  const done = items.filter((t) => t.status === "completed").length;
  const current = items.find((t) => t.status === "in_progress");
  return `Todo list updated: ${done} of ${items.length} done.${current ? ` Working on: ${current.content}` : done === items.length ? " All done." : ""}`;
}

export const allDone = (items: Todo[]) => items.length > 0 && items.every((t) => t.status === "completed");
