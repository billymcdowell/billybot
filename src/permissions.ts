import { addAlwaysAllowed, getAlwaysAllowed, type Mode } from "./storage";

export const MODES: { id: Mode; label: string }[] = [
  { id: "ask", label: "Ask before edits" },
  { id: "acceptEdits", label: "Auto-accept edits" },
  { id: "readOnly", label: "Read-only" },
  { id: "bypass", label: "Bypass all" },
];

// Tools that change something. Reads are always allowed.
const WRITE_TOOLS = new Set(["write_file"]);

export type Approval = "once" | "always" | "deny";
export type AskFn = (tool: string, args: Record<string, unknown>) => Promise<Approval>;

/**
 * Decides whether a tool call may run.
 * Returns null when allowed, or a reason (sent back to the model) when not.
 */
export async function checkPermission(
  tool: string,
  args: Record<string, unknown>,
  mode: Mode,
  folder: string,
  ask: AskFn,
): Promise<string | null> {
  if (!WRITE_TOOLS.has(tool)) return null;
  if (mode === "readOnly") return "Read-only mode is on, so writing files is disabled.";
  if (mode === "acceptEdits" || mode === "bypass") return null;

  // Ask mode: skip the prompt if this tool was "always allowed" for this folder.
  if ((await getAlwaysAllowed(folder)).includes(tool)) return null;

  const answer = await ask(tool, args);
  if (answer === "always") await addAlwaysAllowed(folder, tool);
  return answer === "deny" ? "The user denied this action." : null;
}
