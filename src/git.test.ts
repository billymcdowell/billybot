import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));

import { branchName, describeGit, diffLineKind, gitChanges, gitCommit, gitCreateBranch, gitStatus, isChatBranch, isShowable, type GitInfo } from "./git";
import { cleanMessage, draftCommitMessage } from "./gitMessage";

const info = (over: Partial<GitInfo> = {}): GitInfo => ({ hasGit: true, isRepo: true, branch: "main", detached: false, changed: 0, untracked: 0, blocked: null, ...over });

describe("describeGit", () => {
  it("shows the branch and what has changed", () => {
    expect(describeGit(info())).toBe("main");
    expect(describeGit(info({ changed: 3 }))).toBe("main · 3 changed");
    expect(describeGit(info({ changed: 3, untracked: 1 }))).toBe("main · 3 changed, 1 new");
    expect(describeGit(info({ untracked: 2 }))).toBe("main · 2 new");
    expect(describeGit(info({ detached: true, branch: "abc1234" }))).toBe("detached at abc1234");
    expect(describeGit(info({ branch: null }))).toBe("no commits yet");
  });
});

describe("isShowable and isChatBranch", () => {
  it("only repositories with git installed are shown", () => {
    expect(isShowable(info())).toBe(true);
    expect(isShowable(info({ isRepo: false }))).toBe(false);
    expect(isShowable(info({ hasGit: false }))).toBe(false);
    expect(isShowable(undefined)).toBe(false);
    expect(isChatBranch("billybot/fix-1a2b")).toBe(true);
    expect(isChatBranch("main")).toBe(false);
    expect(isChatBranch(null)).toBe(false);
  });
});

describe("branchName", () => {
  const valid = /^billybot\/[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;
  it("makes a short readable name from the title and the start of the id", () => {
    expect(branchName("Fix the login bug!", "1a2b3c4d-5e6f")).toBe("billybot/fix-the-login-bug-1a2b");
    expect(branchName("  Add   dark MODE  ", "ZZ99-aaaa")).toBe("billybot/add-dark-mode-zz99");
  });
  it("copes with titles that have nothing usable, and long ones", () => {
    expect(branchName("日本語 !!!", "abcd1234")).toBe("billybot/chat-abcd");
    expect(branchName("", "")).toBe("billybot/chat-0000");
    const long = branchName("a".repeat(100), "1234");
    expect(long).toBe(`billybot/${"a".repeat(30)}-1234`);
    expect(branchName("x".repeat(29) + " yyyy", "1234")).toBe(`billybot/${"x".repeat(29)}-1234`);
  });
  it("always passes the rule Rust enforces", () => {
    for (const title of ["Fix the login bug!", "日本語", "", "../../etc", "a;rm -rf /", "--force", "New chat", "x".repeat(200), "$(whoami)"]) {
      expect(branchName(title, "id-1_2~3")).toMatch(valid);
    }
  });
});

describe("diffLineKind", () => {
  it("tells apart the lines of a unified diff", () => {
    expect(["+++ b/a", "--- a/a", "diff --git a/a b/a", "index 1..2", "@@ -1 +1 @@", "+added", "-removed", " context", ""].map(diffLineKind)).toEqual(
      ["meta", "meta", "meta", "meta", "hunk", "add", "del", "context", "context"],
    );
  });
});

describe("talking to Rust", () => {
  it("passes the workspace and project through", async () => {
    await gitStatus("/ws", "app");
    await gitChanges("/ws", "app");
    await gitCreateBranch("/ws", "app", "billybot/x-1");
    await gitCommit("/ws", "app", "msg");
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["git_status", "git_changes", "git_create_branch", "git_commit"]);
    expect(invokeMock).toHaveBeenCalledWith("git_commit", { workspace: "/ws", project: "app", message: "msg" });
    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", { workspace: "/ws", project: "app", name: "billybot/x-1" });
  });
});

describe("cleanMessage", () => {
  it("strips fences, quotes and labels the model adds", () => {
    expect(cleanMessage("```\nAdd tests\n\nMore\n```")).toBe("Add tests\n\nMore");
    expect(cleanMessage("```text\nAdd tests\n```")).toBe("Add tests");
    expect(cleanMessage('"Fix the bug"')).toBe("Fix the bug");
    expect(cleanMessage("Commit message: Fix the bug")).toBe("Fix the bug");
    expect(cleanMessage("  Fix the bug \n")).toBe("Fix the bug");
    expect(cleanMessage('Say "hi" loudly')).toBe('Say "hi" loudly');
    expect(cleanMessage("")).toBe("");
  });
});

describe("draftCommitMessage", () => {
  const client = (content: string | null) => {
    const create = vi.fn(async (_p: unknown) => ({ choices: [{ message: { content } }] }));
    return { create, client: { chat: { completions: { create } } } as never };
  };

  it("sends the files and the diff, with secrets removed, and returns the cleaned message", async () => {
    const { create, client: c } = client('```\nAdd login form\n```');
    const msg = await draftCommitMessage({
      apiKey: "k", model: "m", files: ["a.ts", "b.ts"], client: c,
      diff: "+const key = 'sk-or-v1-0123456789abcdef0123456789abcdef'",
    });
    expect(msg).toBe("Add login form");
    const sent = JSON.stringify(create.mock.calls[0][0]);
    expect(sent).toContain("a.ts\\nb.ts");
    expect(sent).toContain("[REDACTED:api-key]");
    expect(sent).not.toContain("0123456789abcdef");
    expect(create.mock.calls[0][0]).toMatchObject({ model: "m" });
  });

  it("cuts a huge diff", async () => {
    const { create, client: c } = client("Do it");
    await draftCommitMessage({ apiKey: "k", model: "m", files: [], diff: "x".repeat(100_000), client: c });
    expect(JSON.stringify(create.mock.calls[0][0]).length).toBeLessThan(32_000);
    expect(JSON.stringify(create.mock.calls[0][0])).toContain("diff cut off");
  });

  it("complains when the model says nothing", async () => {
    await expect(draftCommitMessage({ apiKey: "k", model: "m", files: [], diff: "", client: client(null).client })).rejects.toThrow("didn't suggest");
  });
});
