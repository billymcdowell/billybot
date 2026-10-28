import { fileTools } from "./files";
import { metaTools } from "./meta";
import { projectTools } from "./projects";
import { searchTools } from "./search";
import { shellTools } from "./shell";
import type { AgentRole, Tool } from "./types";

// The order is what the model (and the context meter) sees.
export const TOOLS: Tool[] = [...projectTools, ...shellTools, ...fileTools, ...searchTools, ...metaTools];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): Tool | undefined => byName.get(name);

/** The tool definitions an agent sends with every request. Subagents only get what their role allows. */
export function toolsFor(role: AgentRole = "main") {
  return TOOLS.filter((t) => t.roles.includes(role)).map((t) => t.definition);
}
