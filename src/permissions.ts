import { addAlwaysAllowed, getAlwaysAllowed, type Mode } from "./storage";

export const MODES: { id: Mode; label: string; hint: string; tone: string }[] = [
  { id: "ask", label: "Ask before edits", hint: "Each edit asks. Commands always ask.", tone: "" },
  { id: "acceptEdits", label: "Auto-accept edits", hint: "Edits go through. Commands still ask.", tone: "text-amber-600 dark:text-amber-400" },
  { id: "plan", label: "Plan", hint: "Read-only. The agent explores and proposes a plan for you to approve.", tone: "text-blue-600 dark:text-blue-400" },
  { id: "readOnly", label: "Read-only", hint: "No changes and no commands at all.", tone: "" },
  { id: "bypass", label: "Bypass all", hint: "Nothing asks, except commands flagged as dangerous.", tone: "text-red-600 dark:text-red-400" },
];

/** The modes Shift+Tab steps through. Bypass and Read-only are only chosen from the menu, on purpose. */
const CYCLE: Mode[] = ["ask", "acceptEdits", "plan"];
export function nextMode(current: Mode): Mode {
  const at = CYCLE.indexOf(current);
  return at === -1 ? CYCLE[0] : CYCLE[(at + 1) % CYCLE.length];
}

// Each tool declares a category (see src/tools). "read" and "meta" tools are always allowed.
//  - write: changes files or the workspace. Asks in Ask mode; Auto-accept and Bypass let it through.
//  - command, git, network: reach beyond the folder lock, so they are held to a stricter rule:
//    Auto-accept still asks, only Bypass runs them without a prompt, and "Always allow" is never
//    remembered, since that would approve every future one.
// Plan and Read-only refuse writes, commands and git. Network is refused in Read-only only: in
// Plan the agent may look things up, but each lookup still asks.
export type ToolCategory = "read" | "write" | "command" | "git" | "network" | "meta";

export type Approval = "once" | "always" | "deny";

/** What the approval card shows. */
export type ApprovalRequest = {
  tool: string;
  category: ToolCategory;
  args: Record<string, unknown>;
  who: string; // "Main agent" or "bakery-api agent"
  where: string; // the project name, or "workspace" for create_project
  before?: string | null; // write_file: the file's current text, or null if it doesn't exist yet
  danger?: string; // why this call is risky enough to ask even in Bypass mode
  warning?: string; // something to look at before approving, such as a key inside a command
  mode?: Mode; // shown on the card
  owner?: string; // for a subagent's request: the delegate_task call that started it
};
export type AskFn = (req: ApprovalRequest) => Promise<Approval>;

/**
 * Decides whether a tool call may run.
 * `scope` is where "always allow" is remembered: the project's path,
 * or the workspace path for create_project.
 * Returns null when allowed, or a reason (sent back to the model) when not.
 */
export async function checkPermission(
  req: ApprovalRequest,
  mode: Mode,
  scope: string,
  ask: AskFn,
): Promise<string | null> {
  const strict = req.category === "command" || req.category === "git" || req.category === "network";
  if (!strict && req.category !== "write") return null;
  if (mode === "readOnly") return "Read-only mode is on, so changes and commands are disabled.";
  if (mode === "plan" && req.category !== "network") {
    return "Plan mode is on, so changes and commands are disabled. Describe your plan instead; the user will approve it before you can make changes.";
  }
  // Bypass skips the prompt, except for a command flagged as dangerous (see src/dangerous.ts).
  if (mode === "bypass" && !req.danger) return null;
  if (mode === "acceptEdits" && !strict) return null;

  // Ask mode: skip the prompt if this tool was "always allowed" here (never for the stricter kinds).
  if (!strict && (await getAlwaysAllowed(scope)).includes(req.tool)) return null;

  const answer = await ask(req);
  if (answer === "always" && !strict) await addAlwaysAllowed(scope, req.tool);
  return answer === "deny" ? "The user denied this action." : null;
}
