export interface DailyMean {
  day: string; // 'YYYY-MM-DD'
  mean: number;
  count: number;
  dateUtcMs: number;
}

/**
 * Groups metric entries by UTC calendar day and computes arithmetic mean per day.
 */
export function bucketToDailyMeans(
  entries: Array<{ startTime: Date | string; valueNumeric?: number | null }>
): Map<string, DailyMean> {
  const buckets = new Map<string, number[]>();

  for (const entry of entries) {
    if (typeof entry.valueNumeric === 'number' && !isNaN(entry.valueNumeric)) {
      const entryDate = new Date(entry.startTime);
      const dayKey = entryDate.toISOString().slice(0, 10);
      const list = buckets.get(dayKey) || [];
      list.push(entry.valueNumeric);
      buckets.set(dayKey, list);
    }
  }

  const result = new Map<string, DailyMean>();
  for (const [dayKey, vals] of buckets.entries()) {
    if (vals.length === 0) continue;
    const sum = vals.reduce((acc, v) => acc + v, 0);
    const mean = sum / vals.length;
    const dateUtcMs = Date.parse(`${dayKey}T00:00:00.000Z`);
    result.set(dayKey, {
      day: dayKey,
      mean,
      count: vals.length,
      dateUtcMs,
    });
  }

  return result;
}
