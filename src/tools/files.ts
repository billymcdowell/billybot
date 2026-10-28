import { invoke } from "@tauri-apps/api/core";
import { fn } from "./define";
import { need, openProjectFor, pp } from "./access";
import type { Tool, ToolArgs } from "./types";

const path = {
  type: "string",
  description: 'Starts with an open project\'s name, e.g. "my-app/src/index.ts". Use "my-app" for its root.',
};

const filePath = (args: ToolArgs) => String(args.path ?? "");

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
    definition: fn("read_file", "Read a text file.", { path }, ["path"]),
    category: "read",
    roles: ["main", "sub"],
    parallelSafe: true,
    target: (args, o) => openProjectFor(false, filePath(args), o),
    run: (_args, t, { o }) => invoke<string>("read_file", { workspace: o.workspace, ...pp(need(t)) }),
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
    target: (args, o) => openProjectFor(true, filePath(args), o),
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
    target: (args, o) => openProjectFor(true, filePath(args), o),
    run: (args, t, { o }) =>
      invoke<string>("edit_file", {
        workspace: o.workspace,
        ...pp(need(t)),
        oldText: String(args.old_text ?? ""),
        newText: String(args.new_text ?? ""),
      }),
  },
];
