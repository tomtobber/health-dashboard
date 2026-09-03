import { format, parseISO } from 'date-fns';
import { EnrichedMetricQueryResult } from '../types';

export interface ChartTimelinePoint {
  time: string;
  timestamp: number;
  [metricType: string]: string | number | undefined;
}

export function isStepsMetricType(metricType: string, unit?: string | null): boolean {
  const m = metricType.toLowerCase();
  const u = (unit || '').toLowerCase();
  return m === 'steps' || m === 'daily-steps-count' || m.includes('step') || u === 'steps';
}

/**
 * Transforms enriched metric query results into a unified, chronologically sorted
 * array of timeline points keyed by epoch timestamp.
 * Metric entries of type 'steps' are aggregated as daily sums (steps per day).
 */
export function buildChartTimelineData(
  numericMetrics: EnrichedMetricQueryResult[],
  isDaily: boolean
): ChartTimelinePoint[] {
  const timeMap = new Map<string, ChartTimelinePoint>();

  for (const metric of numericMetrics) {
    const isSteps = isStepsMetricType(metric.metricType, metric.unit);

    if (isSteps) {
      // Steps entries are always aggregated as steps per day
      const dayTotals = new Map<string, { sum: number; ts: number }>();

      for (const entry of metric.entries) {
        if (entry.valueNumeric === undefined || entry.valueNumeric === null) continue;

        const rawDate = typeof entry.startTime === 'string' ? parseISO(entry.startTime) : new Date(entry.startTime);
        if (isNaN(rawDate.getTime())) continue;

        const dayKey = format(rawDate, 'yyyy-MM-dd');
        const ts = new Date(`${dayKey}T12:00:00.000Z`).getTime();

        const current = dayTotals.get(dayKey) || { sum: 0, ts };
        current.sum += entry.valueNumeric;
        dayTotals.set(dayKey, current);
      }

      for (const [dayKey, { sum, ts }] of dayTotals.entries()) {
        const timeKey = isDaily ? dayKey : `${dayKey}T12:00:00.000Z`;
        if (!timeMap.has(timeKey)) {
          timeMap.set(timeKey, {
            time: timeKey,
            timestamp: ts,
          });
        }
        const point = timeMap.get(timeKey)!;
        point[metric.metricType] = Math.round(sum);
      }
    } else {
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
  }

  return Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
}
