import { NormalizedMetricEntry } from '../adapters/baseAdapter';
import { logger } from '../utils/logger';

export const HIGH_FREQUENCY_METRICS = new Set(['heart_rate']);

export function downsampleEntries(
  entries: NormalizedMetricEntry[],
  bucketMinutes: number = 1
): NormalizedMetricEntry[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  const bucketMs = bucketMinutes * 60 * 1000;
  const highFreqEntries: NormalizedMetricEntry[] = [];
  const standardEntries: NormalizedMetricEntry[] = [];

  for (const entry of entries) {
    if (HIGH_FREQUENCY_METRICS.has(entry.metricType) && entry.valueNumeric !== undefined && entry.valueNumeric !== null) {
      highFreqEntries.push(entry);
    } else {
      standardEntries.push(entry);
    }
  }

  if (highFreqEntries.length === 0) {
    return standardEntries;
  }

  const groups = new Map<string, NormalizedMetricEntry[]>();

  for (const entry of highFreqEntries) {
    const startMs = entry.startTime.getTime();
    const bucketStartMs = Math.floor(startMs / bucketMs) * bucketMs;
    const bucketKey = entry.userId + '|' + entry.provider + '|' + entry.metricType + '|' + entry.sourceStream + '|' + bucketStartMs;

    const group = groups.get(bucketKey);
    if (group) {
      group.push(entry);
    } else {
      groups.set(bucketKey, [entry]);
    }
  }

  const downsampled: NormalizedMetricEntry[] = [];

  for (const [key, groupEntries] of groups.entries()) {
    if (groupEntries.length === 0) continue;

    const first = groupEntries[0];
    const keyParts = key.split('|');
    const bucketStartMs = parseInt(keyParts[4], 10);
    const bucketStartTime = new Date(bucketStartMs);
    const bucketEndTime = new Date(bucketStartMs + bucketMs);

    const sum = groupEntries.reduce((acc, curr) => acc + (curr.valueNumeric ?? 0), 0);
    const avgValue = Number((sum / groupEntries.length).toFixed(2));

    downsampled.push({
      userId: first.userId,
      provider: first.provider,
      metricType: first.metricType,
      externalId: groupEntries.length === 1 ? first.externalId : undefined,
      startTime: bucketStartTime,
      endTime: bucketEndTime,
      valueNumeric: avgValue,
      unit: first.unit,
      sourceStream: first.sourceStream,
      aggregation: bucketMinutes + 'm_avg',
      rawPayload: {
        samplesCount: groupEntries.length,
        samples: groupEntries.map((e) => ({
          startTime: e.startTime.toISOString(),
          endTime: e.endTime.toISOString(),
          value: e.valueNumeric,
          externalId: e.externalId,
          rawPayload: e.rawPayload,
        })),
      },
    });
  }

  logger.info('Downsampled metrics successfully', {
    operation: 'downsampleEntries',
    inputCount: entries.length,
    highFreqCount: highFreqEntries.length,
    downsampledCount: downsampled.length,
    outputCount: standardEntries.length + downsampled.length,
  });

  return [...standardEntries, ...downsampled].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime()
  );
}
