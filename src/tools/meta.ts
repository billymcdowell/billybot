import { parseTodos, summarizeTodos } from "../todos";
import { fn } from "./define";
import type { Tool } from "./types";

const MAX_OPTIONS = 6;

export const metaTools: Tool[] = [
  {
    name: "todo_write",
    definition: fn(
      "todo_write",
      "Keep a to-do list for a task with three or more steps. Send the WHOLE list every time (it replaces the last one). Keep exactly one item in_progress, and mark items completed as soon as they're done. The user sees the list. Skip it for simple requests.",
      {
        items: {
          type: "array",
          description: "Every item, in order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "A short description of the step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      ["items"],
    ),
    category: "meta",
    roles: ["main"],
    parallelSafe: false,
    run: async (args, _t, { o }) => {
      const items = parseTodos(args.items);
      o.onTodos?.(items);
      return summarizeTodos(items);
    },
  },
  {
    name: "ask_user",
    definition: fn(
      "ask_user",
      "Ask the user a question and wait for the answer. Use it for a decision only they can make (which of two approaches, a detail you can't find out by looking). Don't ask what you can discover yourself, and don't ask more than you need. Offer short options when there are obvious choices; the user can always type their own answer.",
      {
        question: { type: "string", description: "One clear question." },
        options: { type: "array", items: { type: "string" }, description: `Up to ${MAX_OPTIONS} short choices (optional).` },
      },
      ["question"],
    ),
    category: "meta",
    roles: ["main"],
    parallelSafe: false, // it waits for a person, so it runs alone
    run: async (args, _t, { o }) => {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) throw new Error("question must not be empty.");
      if (question.length > 600) throw new Error("Keep the question under 600 characters.");
      const rawOptions = args.options === undefined ? [] : args.options;
      if (!Array.isArray(rawOptions) || rawOptions.some((x) => typeof x !== "string" || !x.trim() || x.length > 120)) {
        throw new Error("options must be a list of short, non-empty strings.");
      }
      const options = (rawOptions as string[]).map((x) => x.trim()).slice(0, MAX_OPTIONS);
      if (!o.askUser) return "The user can't be asked right now. Use your best judgment, and say what you assumed.";
      const answer = await o.askUser({ question, options });
      return answer === null ? "The user didn't answer (the run was stopped)." : `The user answered: ${answer}`;
    },
  },
];
