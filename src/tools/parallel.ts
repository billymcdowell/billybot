/** Runs `fn` on every item, at most `limit` at a time, and returns the results in the order of `items`. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error }; // keep going: one failure shouldn't leave the others half done
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * Splits a turn's tool calls into groups. Neighbouring calls that are safe to run together (they
 * only read, and never ask you anything) form one parallel group; every other call is a group of
 * one, so it runs alone and in its place. A write between two reads is a barrier.
 */
export function groupCalls<T>(calls: T[], isParallel: (call: T) => boolean): { parallel: boolean; calls: T[] }[] {
  const groups: { parallel: boolean; calls: T[] }[] = [];
  for (const call of calls) {
    const parallel = isParallel(call);
    const last = groups[groups.length - 1];
    if (parallel && last?.parallel) last.calls.push(call);
    else groups.push({ parallel, calls: [call] });
  }
  return groups;
}
