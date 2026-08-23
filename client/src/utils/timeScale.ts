import { format, parseISO } from 'date-fns';
import { EnrichedMetricQueryResult } from '../types';

export interface ChartTimelinePoint {
  time: string;
  timestamp: number;
  [metricType: string]: any;
}

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

/**
 * Calculates the exact rendered horizontal x-coordinate for a given epoch timestamp
 * under Recharts' type="number", scale="time", domain=['dataMin', 'dataMax'] layout.
 */
export function computeTimeScaledX(
  timestamp: number,
  minTimestamp: number,
  maxTimestamp: number,
  plotWidth = 500,
  leftMargin = 10
): number {
  if (maxTimestamp <= minTimestamp) return leftMargin;
  const fraction = (timestamp - minTimestamp) / (maxTimestamp - minTimestamp);
  return leftMargin + fraction * plotWidth;
}
