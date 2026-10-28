import { invoke } from "@tauri-apps/api/core";
import { fn } from "./define";
import { need, openProjectFor, pp } from "./access";
import { parseEdits } from "../edits";
import { hasPlaceholder } from "../redact";
import type { AgentOptions, Tool, ToolArgs } from "./types";

const path = {
  type: "string",
  description: 'Starts with an open project\'s name, e.g. "my-app/src/index.ts". Use "my-app" for its root.',
};

const filePath = (args: ToolArgs) => String(args.path ?? "");

/**
 * Secrets are hidden from the model and replaced with a [REDACTED:…] placeholder. If it wrote
 * one back into a file it would replace the real value, so that is refused before anything is asked.
 */
function refusePlaceholders(o: AgentOptions, ...texts: unknown[]) {
  if (o.redact === false) return;
  if (texts.some((t) => typeof t === "string" && hasPlaceholder(t))) {
    throw new Error(
      "Refused: the text contains a [REDACTED:…] placeholder. Secrets are hidden from you, so a placeholder stands in for a real value you can't see, and writing it would replace the real value in the file. Leave that part of the file as it is, or ask the user to change it themselves.",
    );
  }
}

export const fileTools: Tool[] = [
  {
    name: "list_dir",
    definition: fn("list_dir", "List files and folders. Folder names end with /.", { path }, ["path"]),
    category: "read",
    roles: ["main", "sub"],
    parallelSafe: true,
    target: (args, o) => openProjectFor(false, filePath(args), o),
    run: async (_args, t, { o }) => {
      const names = await invoke<string[]>("list_dir", { workspace: o.workspace, ...pp(need(t)) });
      return names.join("\n") || "(empty folder)";
    },
  },
  {
    name: "read_file",
    definition: fn(
      "read_file",
      "Read a text file. Long files are cut off with a note saying which lines you got; call again with offset to read on.",
      {
        path,
        offset: { type: "number", description: "Line to start at, counting from 1. Default 1." },
        limit: { type: "number", description: "Most lines to return. Default and maximum 2000." },
      },
      ["path"],
    ),
    category: "read",
    roles: ["main", "sub"],
    parallelSafe: true,
    target: (args, o) => openProjectFor(false, filePath(args), o),
    run: (args, t, { o }) =>
      invoke<string>("read_lines", {
        workspace: o.workspace,
        ...pp(need(t)),
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
  },
  {
    name: "write_file",
    definition: fn(
      "write_file",
      "Create a new text file, or replace a file completely, with its full new contents. For a small change to an existing file, use edit_file instead. The project must be open as writable.",
      { path, content: { type: "string" } },
      ["path", "content"],
    ),
    category: "write",
    roles: ["main", "sub"],
    parallelSafe: false,
    target: (args, o) => {
      refusePlaceholders(o, args.content);
      return openProjectFor(true, filePath(args), o);
    },
    // For a full rewrite, fetch the current text so the approval card can show what changes.
    preview: (_args, t, o) => invoke<string>("read_file", { workspace: o.workspace, ...pp(need(t)) }).catch(() => null),
    run: (args, t, { o }) =>
      invoke<string>("write_file", { workspace: o.workspace, ...pp(need(t)), content: String(args.content ?? "") }),
  },
  {
    name: "edit_file",
    definition: fn(
      "edit_file",
      "Change part of an existing file by replacing one exact snippet. Read the file first and copy old_text exactly, including spaces and line breaks. It must match exactly once, so include enough surrounding lines to be unique. The project must be open as writable.",
      {
        path,
        old_text: { type: "string", description: "The exact text to replace." },
        new_text: { type: "string", description: "What to put in its place." },
      },
      ["path", "old_text", "new_text"],
    ),
    category: "write",
    roles: ["main", "sub"],
    parallelSafe: false,
    target: (args, o) => {
      refusePlaceholders(o, args.old_text, args.new_text);
      return openProjectFor(true, filePath(args), o);
    },
    run: (args, t, { o }) =>
      invoke<string>("edit_file", {
        workspace: o.workspace,
        ...pp(need(t)),
        oldText: String(args.old_text ?? ""),
        newText: String(args.new_text ?? ""),
      }),
  },
  {
    name: "multi_edit",
    definition: fn(
      "multi_edit",
      "Make several changes to one existing file in a single step. Edits are applied in order, each to the result of the one before, and each old_text must match exactly once. If any edit fails, none are applied. Prefer this to repeated edit_file calls on the same file. The project must be open as writable.",
      {
        path,
        edits: {
          type: "array",
          description: "The changes, in the order to apply them.",
          items: {
            type: "object",
            properties: {
              old_text: { type: "string", description: "The exact text to replace." },
              new_text: { type: "string", description: "What to put in its place." },
            },
            required: ["old_text", "new_text"],
          },
        },
      },
      ["path", "edits"],
    ),
    category: "write",
    roles: ["main", "sub"],
    parallelSafe: false,
    target: (args, o) => {
      const edits = parseEdits(args.edits); // a malformed call is the model's mistake: say so before asking the user anything
      refusePlaceholders(o, ...edits.flatMap((e) => [e.old_text, e.new_text]));
      return openProjectFor(true, filePath(args), o);
    },
    preview: (_args, t, o) => invoke<string>("read_file", { workspace: o.workspace, ...pp(need(t)) }).catch(() => null),
    run: (args, t, { o }) =>
      invoke<string>("multi_edit", { workspace: o.workspace, ...pp(need(t)), edits: parseEdits(args.edits) }),
  },
];
