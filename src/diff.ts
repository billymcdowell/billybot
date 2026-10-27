export type DiffLine = { kind: "add" | "del" | "same"; text: string };
export type DiffRow = DiffLine | { kind: "gap"; count: number };

// Above this many cells the exact comparison gets slow, so we fall back to "all removed, all added".
const MAX_CELLS = 4_000_000;

const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** Line-by-line diff of two texts. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);

  // Most edits touch a small patch in the middle, so trim the matching start and end first.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  out.push(...diffMiddle(a.slice(start, endA), b.slice(start, endB)));
  out.push(...a.slice(endA).map((text): DiffLine => ({ kind: "same", text })));
  return out;
}

/** Longest-common-subsequence diff of the part that differs. */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  // t[i][j] = length of the longest common run of a[i..] and b[j..]
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Keeps changed lines plus a little context, and folds long unchanged stretches into a gap row. */
export function collapseDiff(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });

  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (skipped) rows.push({ kind: "gap", count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ kind: "gap", count: skipped });
  return rows;
}
