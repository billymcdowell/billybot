import { invoke } from "@tauri-apps/api/core";
import { dangerousReason } from "../dangerous";
import { resolveLimits } from "../limits";
import { isWindows } from "../platform";
import { redactWithCount } from "../redact";
import { need, openProjectForCommand } from "./access";
import { fn } from "./define";
import type { Tool } from "./types";

// Windows runs commands in PowerShell; macOS and Linux use a POSIX shell.
const SHELL_NOTE = isWindows
  ? " Commands run in Windows PowerShell 5.1, not bash: use PowerShell syntax (Get-ChildItem, $env:NAME, `;` to chain) and Windows paths."
  : "";

export const shellTools: Tool[] = [
  {
    name: "run_command",
    definition: fn(
      "run_command",
      "Run a shell command (tests, a build, installing packages, git) in the folder of an open, writable project. The user must approve every command, so keep each one short and purposeful. It cannot ask questions or take input, and it is stopped after the time limit. Do not use it to read or write files: use the file tools for that." + SHELL_NOTE,
      {
        project: { type: "string", description: "The open, writable project to run the command in." },
        command: { type: "string" },
        timeout_seconds: { type: "number", description: "Optional time limit in seconds. The app has a default and a maximum, so ask for more only for long builds or test runs." },
      },
      ["project", "command"],
    ),
    category: "command",
    roles: ["main"],
    parallelSafe: false,
    subagentRefusal: "Subagents cannot run commands.",
    target: (args, o) => openProjectForCommand(String(args.project ?? ""), o),
    risk: (args) => {
      const command = String(args.command ?? "");
      const danger = dangerousReason(command);
      const hasSecret = redactWithCount(command).count > 0;
      return {
        ...(danger ? { danger } : {}),
        ...(hasSecret ? { warning: "This command contains something that looks like a key or password." } : {}),
      };
    },
    run: (args, t, { o }) => {
      const limits = resolveLimits(o.limits);
      return invoke<string>("run_command", {
        workspace: o.workspace,
        project: need(t).project,
        command: String(args.command ?? ""),
        timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : limits.defaultTimeoutSecs,
        maxTimeoutSeconds: limits.maxTimeoutSecs,
        headChars: limits.outputHeadChars,
        tailChars: limits.outputTailChars,
        runId: o.runKey,
      });
    },
  },
];
