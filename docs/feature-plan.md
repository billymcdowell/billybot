# Plan: 26 agent, safety, history and UX improvements

Covers ideas 1–11, 16–30 and 37 from the improvement list. Written against the code as it is today (`src/agent.ts`, `src/permissions.ts`, `src/storage.ts`, `src-tauri/src/lib.rs`).

Effort: **S** under half a day, **M** about a day, **L** several days.

## What already exists (so we don't rebuild it)

| Idea | Already in the repo | What's left |
|---|---|---|
| 10 Subagent visibility | `SubagentRun` (messages, status, report) is saved per `delegate_task` call id and streamed through `onSubagent` | Live, expandable transcript; per-subagent Stop; usage and elapsed time |
| 21 Timeouts / output limits | `run_command` has a 60s default, 300s max, and keeps head 10k + tail 20k chars | Settings UI; limits on `read_file` / `list_dir` results; a global cap on every tool result |
| 23 Permission modes | `ask`, `acceptEdits`, `readOnly`, `bypass` in `permissions.ts` | Composer control, plan mode, shortcut, per-project default, mode on approval cards |
| 24 Saved history | Chats saved per workspace and listed in the sidebar; delete exists | Search, rename, pinning, storage that scales, interrupted-run repair |
| 9 Parallel tool calls | `delegate_task` calls already run in parallel | Parallel read-only tools |
| 37 Theme | Dark mode follows the OS via `matchMedia` in `main.tsx`; `next-themes` is installed and `sonner.tsx` already calls `useTheme` | A real provider, a toggle and a saved choice |

## Problems in the current code that this plan has to fix first

1. **`agent.ts` hard-codes every tool** in a `switch`, and `permissions.ts` hard-codes `WRITE_TOOLS` / `COMMAND_TOOLS`. Adding about eight tools to that will get messy, and the permission rules for new categories (network, git) have nowhere to live.
2. **All chats live in one `harness.json` array** that `saveConversation` rewrites in full on every save. Checkpoints, usage records and longer chats will make this slow and risky (one bad write loses everything).
3. **`read_file` returns the whole file** with no cap. One big file can fill the context window.
4. **Subagent token usage is dropped** (`onUsage: undefined` in `runSubagent`), so cost tracking would under-report.
5. **There is no test setup on the TypeScript side.** Rust has tests; `agent.ts`, `permissions.ts` and `diff.ts` have none. This plan changes all three heavily.

## Phase 0: Foundations (do these before the features)

### 0.1 Vitest and tests for the agent loop (S)
Add `vitest` and a `test` script, and add `npm test` to `.github/workflows/ci.yml`. First tests: `checkPermission` across all four modes, `splitPath`, `textOf`, and `runAgent` with a fake OpenAI client (inject the client through `AgentOptions` so the loop can be tested without network or Tauri). Everything below leans on these.

### 0.2 Tool registry (M)
Create `src/tools/` with one module per group (`files.ts`, `projects.ts`, `shell.ts`, later `search.ts`, `web.ts`, `meta.ts`) and an `index.ts` registry. Each tool declares:

```ts
type Tool = {
  name: string;
  definition: ChatCompletionTool;
  category: "read" | "write" | "command" | "network" | "meta"; // drives permissions
  roles: ("main" | "sub")[];
  parallelSafe: boolean;                                      // used by idea 9
  run(args, ctx): Promise<string>;
};
```

`execute()` in `agent.ts` becomes: look up the tool → validate the project/path → `checkPermission(category)` → `run` → post-process. `permissions.ts` switches on category instead of tool names. Behaviour must not change; the 0.1 tests prove it.

### 0.3 Result pipeline (S)
One function every tool result passes through: **truncate → redact secrets (idea 19) → record in audit log (idea 22)**. Build the hook now with truncation only; 19 and 22 plug into it.

### 0.4 Storage for chats, checkpoints and logs (M)
Keep `harness.json` for small settings and the "always allow" list. Move bulk data into files under the app data dir, written by Rust commands (atomic write: temp file, then rename):

```
chats/<workspace-hash>/<chat-id>.json     one file per chat
chats/<workspace-hash>/index.json         id, title, updatedAt, pinned, cost, forkedFrom (for the sidebar)
checkpoints/<chat-id>/<turn-id>/...
audit/<yyyy-mm>.jsonl
```

Add `schemaVersion` to the chat file and a one-time migration from the old `chats:<workspace>` store key (keep the old key until the new files verify, then delete). New Rust commands: `chat_read`, `chat_write`, `chat_delete`, `chat_index`. `storage.ts` keeps the same exported function names so `App.tsx` changes are small.

## Phase 1: Quick wins

### 37. Theme toggle (S)
- Replace the `matchMedia` code in `main.tsx` with `next-themes`' `ThemeProvider` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`). The existing `.dark` CSS and `sonner` then work unchanged.
- Add a System / Light / Dark control in the header (or a settings popover). `next-themes` persists the choice itself.
- Check the shiki highlighter (`lib/highlighter.tsx`, `use-highlighted-code.ts`) follows the class, not just the OS setting.
- **Done when:** the choice survives a restart, and code blocks and the diff view switch with it.

### 3. Partial file reads (S)
- Rust `read_file` gains optional `offset` (1-based line) and `limit` (lines). Default cap: 2,000 lines or 100k chars, whichever comes first.
- When it truncates, prepend a header such as `[lines 1–2000 of 8,431. Call again with offset=2001.]` so the model knows to continue.
- No line-number prefixes. The model copies `old_text` for `edit_file`, and a prefix would break exact matching.
- Handle non-UTF-8/binary files with a clear message instead of the raw OS error.
- Keep `loadInstructions` working (it uses `read_file` and already clips).
- **Tests (Rust):** offset past EOF, `limit` 0, CRLF files, a file with no trailing newline, binary file.

### 21. Timeouts and output limits (S)
- Settings (`setSetting`): default command timeout, max timeout, head/tail output sizes, max tool-result size. Pass them to Rust instead of the constants.
- Show the timeout on the `run_command` approval card.
- Apply the global result cap in the 0.3 pipeline (`[truncated N chars]`), which also covers `list_dir`.
- **Done when:** a 5 MB `read_file` or a noisy command can't push a single result past the cap.

### 4. Multi-edit (M)
- Extend `edit_file` with an optional `edits: [{old_text, new_text}]`, or add a separate `multi_edit` tool. A separate tool keeps `edit_file`'s schema simple for weaker models; I recommend that.
- Rust applies the edits in order against the in-memory text. Each `old_text` must match exactly once at its turn. If any edit fails, **nothing is written** and the error names which edit failed. Write once.
- Approval shows one combined diff (`DiffView` already exists; compute it from before/after).
- **Tests (Rust):** edits that depend on earlier edits, one bad edit rolls everything back, overlapping edits, empty list.

### 1. `grep` tool (M)
- Rust using the `ignore` crate (walks like ripgrep and respects `.gitignore`) plus `regex`. Do not follow symlinks, and check every file with the existing `resolve()` lock.
- Arguments: `pattern`, `path`, `glob`, `case_insensitive`, `context` lines, `output` (`files`, `content`, `count`), `max_results`.
- Caps: 200 matches, 300 chars per line, skip binary files. Say when results were cut off.
- Category `read`, so it never prompts. Available to subagents.
- This also delivers `.gitignore`-aware search (idea 42) for free.

### 2. `glob` tool (S)
- Same crate (`ignore` + `globset`), sorted by modified time, capped at 500, same confinement. Returns paths relative to the project, prefixed with the project name the way `list_dir` expects.

## Phase 2: Conversations

### 24. Saved history, finished (M, after 0.4)
- Sidebar search (title and message text; use the index for titles and a lazy full-text scan for bodies).
- Rename, pin, and a better auto-title (first user message now; optionally a cheap model call after the first reply).
- **Interrupted-run repair:** when loading a chat whose last assistant message has `tool_calls` with no matching `tool` results (app quit mid-run), append `"Interrupted: the app closed before this finished"` results so the API accepts the conversation again. This is also what makes **resume (25)** safe.

### 25. Resume and fork (M)
- **Resume:** after repair, show a banner "This run was interrupted" with a Continue button that sends a short synthetic user message. Depends on the 29 "continue" mechanism.
- **Fork:** a "Fork from here" action on any message. Creates a new chat containing messages up to that point, `forkedFrom: {chatId, messageIndex}`, copies open projects and the relevant `subagents` entries. Sidebar shows a fork icon. Keep chats linear (no tree), which is far simpler to render and store.

### 26. Edit and resend (S–M, after 25)
- Edit on a user message → confirm → truncate the chat at that message → run again.
- If checkpoints (17) exist for later turns, ask whether to **revert those file changes** too. Default is to ask, never silently.
- Offer "Edit in a fork" so the original stays intact.

### 27. Export (S)
- Markdown and JSON, from a menu on the chat. Use the dialog plugin's `save` picker, then a Rust `write_export` command (no new broad filesystem permission in `capabilities/default.json`).
- Markdown: user/assistant text, tool calls as collapsed details with truncated results, subagent reports, per-chat cost footer.
- Run exported text through the redaction function (19). Add an "include full tool output" checkbox, off by default.

### 29. Stop, regenerate, continue (M)
- **Stop** already exists. Fix what it does to partial output: keep the streamed text as an assistant message marked `interrupted: true` instead of dropping it, and make sure every pending `tool_call` gets a result.
- **Regenerate:** drop everything after the last user message and run again (offer to revert checkpoints, as in 26).
- **Continue:** shown after "Stopped after 25 steps" or an interrupted message. Sends a synthetic "Continue." and resets the step counter. Consider a settable step limit.

### 30. Message queue (M)
- Keep the composer enabled while `busy`. Enter adds to a `queue` array shown as removable, editable chips above the composer.
- Default: send the next queued message when the turn ends. Optional "Send now" on a chip, which pushes the text into a ref that `runAgent` checks between steps and appends as a user message (steering).
- Stop clears the queue after asking if more than one item is pending.
- Persist the queue in memory only; restart drops it.

### 28. Cost tracking and budget (M)
- Request usage in the response (`usage: {include: true}` for OpenRouter) and store `{promptTokens, completionTokens, cost}` per assistant message. Fall back to `ModelInfo.inputPerM/outputPerM` when OpenRouter gives no cost.
- **Include subagents:** change `onUsage` to receive a `who` and aggregate, rather than passing `undefined`. The context meter should still track only the main conversation.
- UI: per-turn cost under the reply, running total in the header, chat total in the sidebar index.
- Budget: per-chat cap (setting). Checked before each loop step; when hit, stop with a clear message and a "raise cap by $X" button. Show a warning at 80%.
- Handle `"price varies"` models (negative prices, e.g. `openrouter/auto`) by trusting OpenRouter's reported cost only.

## Phase 3: Safety

### 16. Dangerous-command guard (M)
- A rule list in `src/dangerous.ts`: `rm -rf` on `/`, `~`, `..`, or `*`; `sudo`; `curl|wget ... | sh`; `chmod -R`/`chown -R`; `git push --force`, `git reset --hard`, `git clean -fd`; `mkfs`, `dd of=/dev/`; PowerShell `Remove-Item -Recurse -Force`, `Format-Volume`.
- If a command matches, it **always prompts, even in Bypass mode**, and the card shows why it was flagged in red.
- Be honest in the UI and docs: this is a guardrail, not a security boundary. Shell commands can be obfuscated (`r""m`, variables, base64). Real containment is idea 20.
- **Tests:** a table of command strings → flagged/not flagged, including near-misses (`rm -rf ./build` is fine to prompt normally; `rm -rf ~` is flagged).

### 22. Audit log (M, uses 0.3 and 0.4)
- Rust `audit_append` writes one JSON line per tool call to `audit/<yyyy-mm>.jsonl`: time, chat id, workspace, project, who (main / subagent), tool, args (redacted, large content replaced by length + hash), mode, decision (`auto`, `approved`, `always`, `denied`, `refused`), result status, duration, bytes.
- Never log API keys or full file contents.
- UI: a log viewer (table with filters by tool, decision and chat, plus search) and an Export button. Rotation by month; a "delete logs older than N days" setting.

### 19. Secret redaction (M, uses 0.3)
- `src/redact.ts`: patterns for OpenRouter/OpenAI/Anthropic keys (`sk-…`), AWS (`AKIA…`), GitHub (`ghp_…`, `github_pat_…`), Slack, private-key blocks, JWTs, and `KEY=value` lines in `.env*` files where the key name looks secret (`TOKEN`, `SECRET`, `PASSWORD`, `KEY`).
- Applied to tool results before they go to the model, to audit entries, and to exports. Placeholder: `[REDACTED:aws-key]`.
- **Trap to handle:** if the model reads a redacted `.env` and then writes it back, the placeholders would overwrite real secrets. `write_file`, `edit_file` and `multi_edit` must refuse content containing a `[REDACTED:` placeholder, with an explanation the model can act on.
- Setting to turn it off per project; default on. Also warn on the approval card when a command string itself contains something key-shaped.
- It's a safety net, not a guarantee. Entropy-based detection gives too many false positives, so skip it.

### 23. Permission modes UI (S–M)
- Segmented control in the composer showing the current mode with a colour (Bypass is red). Shift+Tab cycles modes.
- New **Plan** mode: read-only tools plus `todo` and `ask_user`; the model ends with a proposed plan and an "Approve and switch to Accept edits" button.
- Per-project default mode (kept next to the "always allow" scope key), and "Always allow" management: list and revoke from a settings dialog (`clearAlwaysAllowed` exists but needs per-tool revoking).
- Approval cards show the active mode and who is asking.
- Add `network` and `git` categories to `checkPermission`. Network defaults to asking per domain; writes keep their current rules.

### 17. Checkpoints and undo (L, uses 0.4)
- **Turn id** = the id of the user message that started the run. Before any `write_file`, `edit_file` or `multi_edit`, Rust saves the file's current bytes (or a "did not exist" marker) into `checkpoints/<chat>/<turn>/` on the first touch of that file in that turn. Do it inside the Rust command so it can't be skipped.
- "Revert this turn" button on each turn that changed files. Restore only files whose current hash still matches what the agent last wrote. If the user (or a command) changed one since, list it and ask before overwriting.
- Files created by the agent are deleted on revert (only if unchanged, and only when empty folders are left behind).
- **Limit, stated in the UI:** `run_command` side effects (installs, deleted files, git operations) are not undone. If the project is a git repo, point at idea 18's branch instead.
- Cleanup: delete checkpoints with the chat, and add a size/age cap setting.
- **Tests (Rust):** create/modify/delete round trip, file changed since the agent's write, symlink escape attempts, concurrent subagents writing in the same turn.

### 18. Git integration (L, uses 0.2 and 23)
- All via the `git` binary with argument arrays (never string-built shell commands), run in the project root. Detect that `git` exists and that the folder is a repo; hide everything otherwise.
- Phase A, read-only: branch + dirty badge in the project header; a "Changes" panel showing `git diff` (staged and unstaged) for what the session changed.
- Phase B, opt-in setting: on the first write in a chat, create and switch to `billybot/<slug>` if the working tree is clean (refuse and explain if not clean; never stash or discard on its own).
- Phase C: a "Commit" button with a message the model drafts and the user edits. No automatic commits, and nothing that pushes.
- Reuse the `network`/`git` permission categories from 23.

### 20. Command sandboxing (L, per OS)
- Setting: **Sandbox commands** (off / on), per project. Applies only to `run_command`.
- macOS: wrap with `sandbox-exec -p <profile>`. Profile allows reads broadly (the login shell needs them), writes only under the project root, `/tmp`/`$TMPDIR` and the caches the toolchain needs, and denies network by default. `sandbox-exec` is deprecated by Apple but still works; note that in the docs.
- Linux: `bwrap` (bubblewrap) if installed (read-only bind of `/`, writable bind of the project, `--unshare-net`). If not installed, say so and fall back to unsandboxed with a visible warning.
- Windows: no equivalent here; the setting is disabled with an explanation.
- A "Allow network for this command" checkbox on the approval card, since `npm install` needs it.
- Must keep working with the process-group kill in `procgroup.rs` (the sandbox wrapper becomes the root of the group).
- Expect to iterate: toolchains write to surprising places (`~/.cargo`, `~/.npm`, `~/Library/Caches`). Start with a failing-command message that says "blocked by sandbox" and which path, so it's debuggable.
- **Tests:** a command that writes outside the project fails; one that writes inside works; network blocked then allowed; cancel still kills children.

## Phase 4: Agent behaviours

### 7. Todo tool (S–M)
- `todo_write({items: [{content, status}]})` replaces the whole list (simple and hard to corrupt). Stored in `Conversation.todos`, not just in memory.
- Category `meta`: no permission prompt. Main agent only.
- UI: a checklist above the composer showing progress, collapsing when everything is done. Mention it in the system prompt for tasks with 3+ steps.

### 8. `ask_user` tool (M)
- `ask_user({question, options?: string[]})`. Rendered as a card with buttons for the options and a free-text box; reuses the approval queue so it can't overlap other prompts. Main agent only (subagents already can't ask, and their prompt says so).
- Stop must resolve any open question as "cancelled" so the loop unwinds. In Plan mode (23) this is the primary way to clarify.
- The answer is returned as the tool result and shown in the transcript.

### 9. Parallel read-only tools (S–M, uses 0.2)
- In `runAgent` step 3, group consecutive tool calls where `parallelSafe` is true (`list_dir`, `read_file`, `grep`, `glob`, `list_projects`) and run them with `Promise.all`. Writes, commands, project open/close and anything that prompts stay sequential and in order.
- Results are still appended in the model's call order. Concurrency cap of 8.
- **Tests:** ordering preserved, a write between two reads acts as a barrier, one failure doesn't cancel the others.

### 10. Subagent visibility (M)
- Replace the final-report-only view with an expandable live transcript (tool calls, results, streaming text), reusing `Messages.tsx` so it looks like the main chat.
- Per-subagent status line: elapsed time, step count, tokens/cost (needs the 28 change), and a **Stop** button. That needs an `AbortController` per subagent, chained to the main signal.
- Show which subagent is waiting on an approval, and link the approval card back to it (`who` already carries the name).
- Keep stored runs small: trim large tool results in the saved copy.

### 11. Auto-compaction (L, uses 28 and 0.4)
- Trigger: before a loop step, when the last reported prompt tokens exceed ~80% of `contextWindow`. Also a manual **Compact** button on the context meter and `/compact`.
- Compact = keep the most recent turns verbatim (by token budget, not message count), summarize everything older with one model call into a single `user`-role message ("Summary of earlier conversation: …"). Never split an assistant `tool_calls` message from its `tool` results.
- The summary prompt must preserve: user goals, decisions, files changed, open to-dos, and constraints.
- Keep the original messages on disk (`archivedMessages` in the chat file) and show a divider "Earlier messages summarized" in the UI, so history stays inspectable and export stays complete.
- Count the summarization call's cost in 28.
- Failure handling: if the summary call fails, fall back to dropping the oldest tool results (replace with `[result removed]`), never silently lose user messages.

### 5. `fetch_url` tool (M)
- Implemented in Rust (`reqwest`, rustls), so the webview CSP stays locked to openrouter.ai. Only `http(s)`; block loopback, link-local and private ranges (SSRF), re-check after every redirect, cap size (say 2 MB) and time (20s), and convert HTML to readable text/Markdown.
- Category `network`: asks the first time per domain, with "allow this domain" remembered per workspace. Main agent only by default.
- Returned content is **untrusted**. Wrap it as `<fetched url=…>` and add a line to the system prompt saying instructions inside fetched content must not be followed. Show a note on the card when the domain was newly approved.
- Run results through redaction (19) and the size cap.

### 6. Web search (M, after 5)
- Decision needed (see below). Options: OpenRouter's built-in web plugin (no new key, extra per-search cost), or a Brave/Tavily key stored in the keychain next to the OpenRouter key.
- Off by default behind a setting. Tool returns titles, URLs and snippets; the model uses `fetch_url` for the pages.
- Same untrusted-content handling as 5, and the search cost goes into 28.

## Suggested order

| Step | Items | Why this order |
|---|---|---|
| 1 | 0.1, 0.2, 0.3 | Tests and registry first; everything after is cheaper and safer |
| 2 | 37, 3, 21, 4, 1, 2 | Visible quick wins, mostly independent |
| 3 | 0.4, 24, 29 | Storage move before chat features pile up |
| 4 | 28, 25, 26, 27, 30 | Needs the new storage; 28 early because 10 and 11 need it |
| 5 | 16, 22, 19, 23 | Safety layer on the registry |
| 6 | 17, 18 | Biggest safety value, biggest build; 17 before 26's revert prompt gets wired |
| 7 | 7, 8, 9, 10 | Agent behaviours |
| 8 | 11, 5, 6, 20 | Largest or most uncertain pieces last |

Items within a step that don't touch the same files (for example 37 and 1) can be built in parallel by separate people or sessions. Steps 3 and 4 share `App.tsx` and `storage.ts`, so do those in sequence.

## Cross-cutting rules

- Every new Rust command goes through `project_root()` and `resolve()`; add a symlink-escape test for each.
- New permission categories default to **ask**. A tool never becomes "always allow" for commands or network by accident.
- Every feature that stores data adds it to the chat `schemaVersion` migration, and nothing breaks when the field is missing (old chats must still open).
- README: update the feature list, the "Security notes" section (redaction and the guard are not boundaries; sandbox caveats), and add a data-location table for chats, checkpoints and logs.
- CI (macOS, Ubuntu, Windows) must stay green; the `ignore`, `regex`, `globset` and `reqwest` crates all build on all three, but check whisper's build isn't slowed by the new dependencies.

## Decisions needed before building

1. **Web search provider (6):** OpenRouter's web plugin, or a separate search API key?
2. **Sandbox (20):** is a macOS/Linux-only feature acceptable, given Windows has no good equivalent?
3. **Git branch per chat (18B):** on by default, or opt-in? I recommend opt-in.
4. **Edit & resend (26):** truncate in place (simple, destructive) or always fork first (safer, more chats)? I recommend asking each time, defaulting to fork.
5. **Budget cap (28):** per chat only, or also a monthly cap across chats?
6. **Dangerous commands in Bypass (16):** always prompt, or hard-block? I recommend always prompt.
