import { addAlwaysAllowed, getAlwaysAllowed, type Mode } from "./storage";

export const MODES: { id: Mode; label: string }[] = [
  { id: "ask", label: "Ask before edits" },
  { id: "acceptEdits", label: "Auto-accept edits" },
  { id: "readOnly", label: "Read-only" },
  { id: "bypass", label: "Bypass all" },
];

// Tools that change something. Everything else is always allowed.
const WRITE_TOOLS = new Set(["write_file", "create_project"]);

export type Approval = "once" | "always" | "deny";

/** What the approval card shows. */
export type ApprovalRequest = {
  tool: string;
  args: Record<string, unknown>;
  who: string; // "Main agent" or "bakery-api agent"
  where: string; // the project name, or "workspace" for create_project
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
  if (!WRITE_TOOLS.has(req.tool)) return null;
  if (mode === "readOnly") return "Read-only mode is on, so changes are disabled.";
  if (mode === "acceptEdits" || mode === "bypass") return null;

  // Ask mode: skip the prompt if this tool was "always allowed" here.
  if ((await getAlwaysAllowed(scope)).includes(req.tool)) return null;

  const answer = await ask(req);
  if (answer === "always") await addAlwaysAllowed(scope, req.tool);
  return answer === "deny" ? "The user denied this action." : null;
}
