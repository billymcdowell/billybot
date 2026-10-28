import { invoke } from "@tauri-apps/api/core";
import { fn } from "./define";
import { MAX_OPEN_PROJECTS, MAX_SUBAGENTS_PER_TURN } from "./access";
import type { AgentOptions, Tool } from "./types";

async function listProjects(o: AgentOptions) {
  type Info = { name: string; modified: number; summary: string };
  const list = await invoke<Info[]>("list_projects", { workspace: o.workspace });
  if (list.length === 0) return "(no projects yet)";
  return list
    .map((p) => {
      const date = new Date(p.modified * 1000).toISOString().slice(0, 10);
      const open = o.projects.some((x) => x.name === p.name) ? " [open]" : "";
      return `${p.name}${open} · changed ${date}${p.summary ? " · " + p.summary : ""}`;
    })
    .join("\n");
}

async function openProject(name: string, writable: boolean, o: AgentOptions) {
  await invoke("check_project", { workspace: o.workspace, name }); // throws if it isn't a real project
  const existing = o.projects.find((p) => p.name === name);
  if (existing) {
    existing.writable = writable;
  } else {
    if (o.projects.length >= MAX_OPEN_PROJECTS) {
      return `Could not open ${name}: ${MAX_OPEN_PROJECTS} projects are already open. Close one first.`;
    }
    o.projects.push({ name, writable });
  }
  o.onProjectsChange?.([...o.projects]);
  return `Opened ${name} (${writable ? "writable" : "read-only"}).`;
}

const MAIN = ["main" as const];

export const projectTools: Tool[] = [
  {
    name: "list_projects",
    definition: fn("list_projects", "List the projects in the workspace with their README summary.", {}, []),
    category: "read",
    roles: MAIN,
    parallelSafe: true,
    run: (_args, _t, { o }) => listProjects(o),
  },
  {
    name: "open_project",
    definition: fn(
      "open_project",
      "Open an existing project. Read-only by default; pass writable: true only if you need to change it. Opening again changes its access.",
      { name: { type: "string" }, writable: { type: "boolean" } },
      ["name"],
    ),
    category: "meta",
    roles: MAIN,
    parallelSafe: false,
    run: (args, _t, { o }) => openProject(String(args.name), args.writable === true, o),
  },
  {
    name: "close_project",
    definition: fn("close_project", "Close a project you no longer need.", { name: { type: "string" } }, ["name"]),
    category: "meta",
    roles: MAIN,
    parallelSafe: false,
    run: async (args, _t, { o }) => {
      o.projects.splice(0, o.projects.length, ...o.projects.filter((p) => p.name !== args.name));
      o.onProjectsChange?.([...o.projects]);
      return `Closed ${args.name}.`;
    },
  },
  {
    name: "create_project",
    definition: fn(
      "create_project",
      "Create a new, empty project folder and open it as writable. Only when no existing project fits. Names: letters, numbers, - and _.",
      { name: { type: "string" } },
      ["name"],
    ),
    category: "write",
    roles: MAIN,
    parallelSafe: false,
    run: async (args, _t, { o }) => {
      const name = await invoke<string>("create_project", { workspace: o.workspace, name: String(args.name) });
      return `Created ${name}. ` + (await openProject(name, true, o));
    },
  },
  {
    name: "delegate_task",
    definition: fn(
      "delegate_task",
      "Hand a self-contained task in one project to a subagent. It gets write access to that project only, works on its own, and returns a report. Calls made in the same turn run in parallel.",
      {
        project: { type: "string" },
        task: {
          type: "string",
          description: "Everything the subagent needs: the goal, constraints, and any shared contract such as data shapes or URLs. It cannot ask you questions.",
        },
      },
      ["project", "task"],
    ),
    category: "meta",
    roles: MAIN,
    parallelSafe: false,
    subagentRefusal: "Subagents cannot delegate.",
    run: async (args, _t, ctx) => {
      if (ctx.delegateSlot >= MAX_SUBAGENTS_PER_TURN) {
        return `Refused: at most ${MAX_SUBAGENTS_PER_TURN} subagents per turn. Run this one later.`;
      }
      return ctx.runSubagent(ctx.callId, String(args.project), String(args.task));
    },
  },
];
