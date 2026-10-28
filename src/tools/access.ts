import { isWindows } from "../platform";
import type { AgentOptions, Target } from "./types";

export const MAX_OPEN_PROJECTS = 3;
export const MAX_SUBAGENTS_PER_TURN = 3;

/** "bakery/src/a.ts" → { project: "bakery", rest: "src/a.ts" } */
export function splitPath(p: string): Target {
  // Models on Windows often write backslashes; Rust accepts "/" there too.
  const clean = (isWindows ? p.replace(/\\/g, "/") : p).replace(/^(\.\/|\/)+/, "");
  const slash = clean.indexOf("/");
  return slash === -1
    ? { project: clean, rest: "" }
    : { project: clean.slice(0, slash), rest: clean.slice(slash + 1) };
}

/** Checks a file-tool path against the open projects. Throws a helpful error if not allowed. */
export function openProjectFor(writes: boolean, p: string, o: AgentOptions): Target {
  const { project, rest } = splitPath(p);
  const open = o.projects.find((x) => x.name === project);
  if (!open) {
    const names = o.projects.map((x) => x.name).join(", ") || "none";
    throw new Error(`"${project}" is not open. Paths must start with an open project (open: ${names}).`);
  }
  if (writes && !open.writable) {
    throw new Error(`${project} is open read-only. Call open_project with writable: true to change it.`);
  }
  return { project, rest };
}

/** A command can change anything in its project, so the project must be open and writable. */
export function openProjectForCommand(project: string, o: AgentOptions): Target {
  if (o.role === "sub") throw new Error("Subagents cannot run commands.");
  const open = o.projects.find((x) => x.name === project);
  if (!open) {
    const names = o.projects.map((x) => x.name).join(", ") || "none";
    throw new Error(`"${project}" is not open. Open it first (open: ${names}).`);
  }
  if (!open.writable) {
    throw new Error(`${project} is open read-only. Call open_project with writable: true to run commands in it.`);
  }
  return { project, rest: "" };
}

/** For tools whose `target` always runs first, so a missing one is a bug in the tool. */
export function need(target: Target | null): Target {
  if (!target) throw new Error("Internal error: this tool needs a project target.");
  return target;
}

/** The arguments the Rust file commands take. */
export const pp = (t: Target) => ({ project: t.project, path: t.rest });
