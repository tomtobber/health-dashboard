import { NormalizedMetricEntry } from '../adapters/baseAdapter';

export interface MetricQueryFilter {
  userId: string;
  metricType: string;
  startTime: Date;
  endTime: Date;
}

export interface MetricEntryWithDelete extends NormalizedMetricEntry {
  deletedAt?: Date | null;
}

export function filterReconciledOverRaw(entries: MetricEntryWithDelete[]): NormalizedMetricEntry[] {
  const activeEntries = entries.filter((e) => !e.deletedAt);

  const reconciledMap = new Map<string, NormalizedMetricEntry>();
  const rawEntries: NormalizedMetricEntry[] = [];

  for (const entry of activeEntries) {
    if (entry.sourceStream === 'reconciled') {
      const key = `${entry.startTime.toISOString()}-${entry.endTime.toISOString()}`;
      reconciledMap.set(key, entry);
    } else {
      rawEntries.push(entry);
    }
  }

  const result: NormalizedMetricEntry[] = Array.from(reconciledMap.values());

  for (const raw of rawEntries) {
    const rawKey = `${raw.startTime.toISOString()}-${raw.endTime.toISOString()}`;
    if (!reconciledMap.has(rawKey)) {
      result.push(raw);
    }
  }

  return result.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}