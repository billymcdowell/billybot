import { invoke } from "@tauri-apps/api/core";
import { fn } from "./define";
import { need, openProjectFor, pp } from "./access";
import type { Tool, ToolArgs } from "./types";

const where = {
  type: "string",
  description: 'A folder or file inside an open project, e.g. "my-app/src". Use "my-app" to search the whole project.',
};

const startPath = (args: ToolArgs) => String(args.path ?? "");
const optionalNumber = (v: unknown) => (typeof v === "number" ? v : undefined);

const SKIPPED = "Skips .git, node_modules, and anything in a .gitignore.";

export const searchTools: Tool[] = [
  {
    name: "grep",
    definition: fn(
      "grep",
      `Search file contents for a regular expression (Rust regex syntax). Returns matching lines as path:line: text, ready for read_file. ${SKIPPED} Binary files are ignored.`,
      {
        pattern: { type: "string", description: "The regular expression. Escape special characters to match them literally." },
        path: where,
        glob: { type: "string", description: 'Only search files matching this pattern, e.g. "*.ts" or "src/**/*.rs".' },
        case_insensitive: { type: "boolean" },
        context: { type: "number", description: "Lines of context to show around each match (0 to 5). Default 0." },
        output: {
          type: "string",
          enum: ["content", "files", "count"],
          description: '"content" (default) lists matching lines, "files" only the files that match, "count" the matches per file.',
        },
        max_results: { type: "number", description: "Stop after this many results. Default 200, at most 1000." },
      },
      ["pattern", "path"],
    ),
    category: "read",
    roles: ["main", "sub"],
    parallelSafe: true,
    target: (args, o) => openProjectFor(false, startPath(args), o),
    run: (args, t, { o }) =>
      invoke<string>("grep_files", {
        workspace: o.workspace,
        ...pp(need(t)),
        pattern: String(args.pattern ?? ""),
        glob: typeof args.glob === "string" ? args.glob : undefined,
        caseInsensitive: args.case_insensitive === true,
        context: optionalNumber(args.context),
        output: typeof args.output === "string" ? args.output : undefined,
        maxResults: optionalNumber(args.max_results),
      }),
  },
  {
    name: "glob",
    definition: fn(
      "glob",
      `Find files by name pattern, newest first. Patterns work like .gitignore lines: "*.ts" matches at any depth, "src/**/*.test.ts" is anchored to the folder you search. ${SKIPPED}`,
      {
        pattern: { type: "string", description: 'For example "*.tsx", "**/package.json" or "docs/**".' },
        path: where,
        max_results: { type: "number", description: "Default and maximum 500." },
      },
      ["pattern", "path"],
    ),
    category: "read",
    roles: ["main", "sub"],
    parallelSafe: true,
    target: (args, o) => openProjectFor(false, startPath(args), o),
    run: (args, t, { o }) =>
      invoke<string>("glob_files", {
        workspace: o.workspace,
        ...pp(need(t)),
        pattern: String(args.pattern ?? ""),
        maxResults: optionalNumber(args.max_results),
      }),
  },
];
