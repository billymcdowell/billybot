import { addAlwaysAllowed, getAlwaysAllowed, type Mode } from "./storage";

export const MODES: { id: Mode; label: string }[] = [
  { id: "ask", label: "Ask before edits" },
  { id: "acceptEdits", label: "Auto-accept edits" },
  { id: "readOnly", label: "Read-only" },
  { id: "bypass", label: "Bypass all" },
];

// Tools that change something. Everything else is always allowed.
const WRITE_TOOLS = new Set(["write_file", "edit_file", "create_project"]);

// Tools that run commands. A command can do anything your user account can, and the folder
// lock doesn't contain it, so these are held to a stricter rule than file edits:
//  - Auto-accept still asks. Only Bypass runs them without a prompt.
//  - "Always allow" is never remembered, since that would approve every future command.
export const COMMAND_TOOLS = new Set(["run_command"]);

export type Approval = "once" | "always" | "deny";

/** What the approval card shows. */
export type ApprovalRequest = {
  tool: string;
  args: Record<string, unknown>;
  who: string; // "Main agent" or "bakery-api agent"
  where: string; // the project name, or "workspace" for create_project
  before?: string | null; // write_file: the file's current text, or null if it doesn't exist yet
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
  const isCommand = COMMAND_TOOLS.has(req.tool);
  if (!isCommand && !WRITE_TOOLS.has(req.tool)) return null;
  if (mode === "readOnly") return "Read-only mode is on, so changes and commands are disabled.";
  if (mode === "bypass") return null;
  if (mode === "acceptEdits" && !isCommand) return null;

  // Ask mode: skip the prompt if this tool was "always allowed" here (never for commands).
  if (!isCommand && (await getAlwaysAllowed(scope)).includes(req.tool)) return null;

  const answer = await ask(req);
  if (answer === "always" && !isCommand) await addAlwaysAllowed(scope, req.tool);
  return answer === "deny" ? "The user denied this action." : null;
}
