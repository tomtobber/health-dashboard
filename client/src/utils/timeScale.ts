import { format, parseISO } from 'date-fns';
import { EnrichedMetricQueryResult } from '../types';

export interface ChartTimelinePoint {
  time: string;
  timestamp: number;
  [metricType: string]: string | number | undefined;
}

/**
 * Transforms enriched metric query results into a unified, chronologically sorted
 * array of timeline points keyed by epoch timestamp.
 */
export function buildChartTimelineData(
  numericMetrics: EnrichedMetricQueryResult[],
  isDaily: boolean
): ChartTimelinePoint[] {
  const timeMap = new Map<string, ChartTimelinePoint>();

  for (const metric of numericMetrics) {
    for (const entry of metric.entries) {
      if (entry.valueNumeric === undefined || entry.valueNumeric === null) continue;

      const rawDate = typeof entry.startTime === 'string' ? parseISO(entry.startTime) : new Date(entry.startTime);
      if (isNaN(rawDate.getTime())) continue;

      const timeKey = isDaily ? format(rawDate, 'yyyy-MM-dd') : rawDate.toISOString();
      const ts = isDaily ? new Date(`${timeKey}T12:00:00.000Z`).getTime() : rawDate.getTime();

      if (!timeMap.has(timeKey)) {
        timeMap.set(timeKey, {
          time: timeKey,
          timestamp: ts,
        });
      }

      const point = timeMap.get(timeKey)!;
      point[metric.metricType] = entry.valueNumeric;
    }
  }

  return Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
}
