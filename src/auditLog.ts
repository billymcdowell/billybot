import { invoke } from "@tauri-apps/api/core";
import { parseLines, type ActivityEvent } from "./activity";

// Finished events are written to the audit log (see src-tauri/src/audit.rs) in small batches.
// Events that are still running are only shown live; their finished version is what gets saved.

const FLUSH_AFTER_MS = 1000;
const MAX_WAITING = 5000;

let waiting: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> = Promise.resolve();

export function saveActivity(event: ActivityEvent) {
  if (event.pending) return;
  waiting.push(JSON.stringify(event));
  if (waiting.length > MAX_WAITING) waiting = waiting.slice(-MAX_WAITING);
  timer ??= setTimeout(() => void flushActivity(), FLUSH_AFTER_MS);
}

/** Writes whatever is waiting now. Safe to call at any time; calls queue up behind each other. */
export function flushActivity(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  flushing = flushing.then(async () => {
    if (waiting.length === 0) return;
    const lines = waiting;
    waiting = [];
    try {
      await invoke("audit_append", { lines });
    } catch (e) {
      console.warn("Couldn't write the audit log:", e);
      waiting = [...lines, ...waiting].slice(-MAX_WAITING); // try again with the next batch
    }
  });
  return flushing;
}

/** A chat's saved events, oldest first. */
export async function loadChatActivity(chatId: string, limit = 2000): Promise<ActivityEvent[]> {
  await flushActivity(); // so events from this very session are there too
  try {
    return parseLines(await invoke<string[]>("audit_read", { chatId, limit }));
  } catch (e) {
    console.warn("Couldn't read the audit log:", e);
    return [];
  }
}
