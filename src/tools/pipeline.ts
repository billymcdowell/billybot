import { redactWithCount } from "../redact";

// Every tool result passes through these stages on its way back to the model. Later features
// (secret redaction, the audit log) are added to DEFAULT_STAGES rather than to each tool.

export type ResultInfo = {
  tool: string;
  who: string;
  status: "ok" | "error" | "refused";
  /** Stages add a line here when they change the result ("redacted 2 secrets"), for the activity log. */
  notes?: string[];
};

export type ResultStage = (text: string, info: ResultInfo) => string | Promise<string>;

// About 25k tokens. Command output is already cut smaller in Rust; this is the backstop for
// everything else, such as a huge file from read_file.
export const MAX_RESULT_CHARS = 100_000;

/** Takes well-known secrets out of the result, so the model never sees them. */
export function redactStage(): ResultStage {
  return (text, info) => {
    const { text: clean, count } = redactWithCount(text);
    if (count > 0) info.notes?.push(`redacted ${count} ${count === 1 ? "secret" : "secrets"}`);
    return clean;
  };
}

/** Keeps the start and the end of an over-long result and says how much was removed. */
export function truncateStage(max = MAX_RESULT_CHARS): ResultStage {
  return (text, info) => {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.75);
    const tail = max - head;
    const removed = text.length - head - tail;
    info.notes?.push(`truncated ${removed.toLocaleString("en-US")} characters`);
    return (
      text.slice(0, head) +
      `\n[... ${removed.toLocaleString("en-US")} characters removed from the middle of this result. Ask for a smaller part if you need it ...]\n` +
      text.slice(text.length - tail)
    );
  };
}

/**
 * The stages for one agent run. Redaction comes first, so a secret can't survive by being
 * split across the point where a long result is cut.
 */
export function stagesFor(opts?: { maxResultChars?: number; redact?: boolean }): ResultStage[] {
  return [
    ...(opts?.redact === false ? [] : [redactStage()]),
    truncateStage(opts?.maxResultChars ?? MAX_RESULT_CHARS),
  ];
}

export const DEFAULT_STAGES: ResultStage[] = stagesFor();

/** Runs the stages in order, each one getting the previous one's output. */
export async function processResult(
  text: string,
  info: ResultInfo,
  stages: ResultStage[] = DEFAULT_STAGES,
): Promise<string> {
  let out = text;
  for (const stage of stages) out = await stage(out, info);
  return out;
}
