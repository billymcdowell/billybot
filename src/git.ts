import { invoke } from "@tauri-apps/api/core";

// The frontend side of git (src-tauri/src/git.rs): what a project's repository looks like, the
// changes in it, a branch for a chat, and a commit. These are the app's own buttons; the agent
// uses git through run_command, with approval.

export type GitInfo = {
  hasGit: boolean;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  changed: number; // files with changes to tracked files
  untracked: number;
  blocked: string | null; // why billybot isn't running git here
};

export type FileChange = { path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" };
export type Changes = { files: FileChange[]; diff: string };

export const gitStatus = (workspace: string, project: string) => invoke<GitInfo>("git_status", { workspace, project });
export const gitChanges = (workspace: string, project: string) => invoke<Changes>("git_changes", { workspace, project });
export const gitCreateBranch = (workspace: string, project: string, name: string) =>
  invoke<void>("git_create_branch", { workspace, project, name });
export const gitCommit = (workspace: string, project: string, message: string) =>
  invoke<string>("git_commit", { workspace, project, message });

/** True for a project that is a repository we can show: something to look at in the header. */
export const isShowable = (info: GitInfo | undefined): info is GitInfo => !!info && info.hasGit && info.isRepo;

/** "main", "main · 3 changed", "main · 3 changed, 1 new" */
export function describeGit(info: GitInfo): string {
  const branch = info.branch ? (info.detached ? `detached at ${info.branch}` : info.branch) : "no commits yet";
  const parts = [info.changed ? `${info.changed} changed` : "", info.untracked ? `${info.untracked} new` : ""].filter(Boolean);
  return parts.length ? `${branch} · ${parts.join(", ")}` : branch;
}

export const isChatBranch = (branch: string | null) => !!branch && branch.startsWith("billybot/");

/**
 * A branch name for a chat: "billybot/" plus the start of its title and four characters of its id
 * (so two chats with the same title don't collide). Lowercase letters, digits and dashes only,
 * which is all Rust accepts.
 */
export function branchName(title: string, chatId: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  const id = chatId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 4) || "0000";
  return `billybot/${slug || "chat"}-${id}`;
}

/** Colour class for one line of a unified diff. */
export function diffLineKind(line: string): "add" | "del" | "hunk" | "meta" | "context" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}
