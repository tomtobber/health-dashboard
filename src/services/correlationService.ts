import { queryBatchEnrichedMetrics } from './metricsQueryService';
import { bucketToDailyMeans } from '../utils/dailyBucketing';
import { ValidationError } from '../errors/AppError';
import { BaselineWindowSchema, round3, DEFAULT_BASELINE_WINDOW_DAYS } from './baselineService';

export const MIN_CORRELATION_SAMPLE_SIZE = 10;
export const CORRELATION_SIGNIFICANCE_THRESHOLD = 0.3;

export interface PairedDailyAveragePoint {
  day: string; // YYYY-MM-DD
  valueA: number;
  valueB: number;
}

export type CorrelationResult =
  | {
      ok: true;
      metricTypeA: string;
      metricTypeB: string;
      displayNameA: string;
      displayNameB: string;
      unitA?: string;
      unitB?: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number; // count of aligned UTC calendar days
      correlationCoefficient: number; // Pearson r, round3, -0 -> 0
      hasClearCorrelation: boolean; // |r| >= CORRELATION_SIGNIFICANCE_THRESHOLD
      pairedDailyAverages: PairedDailyAveragePoint[];
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricTypeA: string;
      metricTypeB: string;
      displayNameA: string;
      displayNameB: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };

/**
 * Computes descriptive Pearson correlation between two user-chosen numeric/duration metrics
 * over an aligned UTC calendar daily-mean series.
 */
export async function getMetricPairCorrelation(
  userId: string,
  metricTypeA: string,
  metricTypeB: string,
  windowDaysOverride?: number
): Promise<CorrelationResult> {
  if (metricTypeA === metricTypeB) {
    throw new ValidationError('Cannot compute correlation of a metric with itself', {
      operation: 'getMetricPairCorrelation',
      userId,
      metricTypeA,
      metricTypeB,
    });
  }

  let windowDays = DEFAULT_BASELINE_WINDOW_DAYS;
  if (windowDaysOverride !== undefined) {
    const parseResult = BaselineWindowSchema.safeParse({ windowDays: windowDaysOverride });
    if (!parseResult.success) {
      throw new ValidationError('Invalid windowDays query parameter', {
        operation: 'getMetricPairCorrelation',
        userId,
        metricTypeA,
        metricTypeB,
        windowDaysOverride,
        zodErrors: parseResult.error.errors,
      });
    }
    windowDays = parseResult.data.windowDays;
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - windowDays * 86400000);
  const endTime = now;

  const batchResults = await queryBatchEnrichedMetrics({
    userId,
    metricTypes: [metricTypeA, metricTypeB],
    startTime,
    endTime,
  });

  const enrichedA = batchResults.find((r) => r.metricType === metricTypeA);
  const enrichedB = batchResults.find((r) => r.metricType === metricTypeB);

  if (!enrichedA || !enrichedB) {
    throw new ValidationError('Could not resolve metric metadata for correlation', {
      operation: 'getMetricPairCorrelation',
      userId,
      metricTypeA,
      metricTypeB,
    });
  }

  if (enrichedA.valueType !== 'numeric' && enrichedA.valueType !== 'duration') {
    throw new ValidationError(
      `Correlation is only supported for numeric or duration metrics, received '${enrichedA.valueType}' for ${metricTypeA}`,
      {
        operation: 'getMetricPairCorrelation',
        userId,
        metricType: metricTypeA,
        valueType: enrichedA.valueType,
      }
    );
  }

  if (enrichedB.valueType !== 'numeric' && enrichedB.valueType !== 'duration') {
    throw new ValidationError(
      `Correlation is only supported for numeric or duration metrics, received '${enrichedB.valueType}' for ${metricTypeB}`,
      {
        operation: 'getMetricPairCorrelation',
        userId,
        metricType: metricTypeB,
        valueType: enrichedB.valueType,
      }
    );
  }

  // 1. Group each metric into UTC daily means
  const meansA = bucketToDailyMeans(enrichedA.entries);
  const meansB = bucketToDailyMeans(enrichedB.entries);

  // 2. Aligned days: inner join on matching UTC calendar days
  const alignedDays: string[] = [];
  for (const dayKey of meansA.keys()) {
    if (meansB.has(dayKey)) {
      alignedDays.push(dayKey);
    }
  }
  alignedDays.sort();

  const sampleSize = alignedDays.length;

  // 3. Sample size gating (minimum 10 aligned days)
  if (sampleSize < MIN_CORRELATION_SAMPLE_SIZE) {
    return {
      ok: false,
      reason: 'insufficient_data',
      metricTypeA,
      metricTypeB,
      displayNameA: enrichedA.displayName,
      displayNameB: enrichedB.displayName,
      windowDays,
      sampleSize,
      minRequired: MIN_CORRELATION_SAMPLE_SIZE,
    };
  }

  // 4. Construct paired daily averages array
  const pairedDailyAverages: PairedDailyAveragePoint[] = [];
  let sumX = 0;
  let sumY = 0;

  for (const dayKey of alignedDays) {
    const valA = meansA.get(dayKey)!.mean;
    const valB = meansB.get(dayKey)!.mean;
    pairedDailyAverages.push({
      day: dayKey,
      valueA: valA,
      valueB: valB,
    });
    sumX += valA;
    sumY += valB;
  }

  const N = sampleSize;
  const meanX = sumX / N;
  const meanY = sumY / N;

  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;

  for (const pair of pairedDailyAverages) {
    const dx = pair.valueA - meanX;
    const dy = pair.valueB - meanY;
    Sxx += dx * dx;
    Syy += dy * dy;
    Sxy += dx * dy;
  }

  // 5. Pearson r computation with zero-variance safety guard
  let r = 0;
  if (Sxx > 0 && Syy > 0) {
    const denominator = Math.sqrt(Sxx * Syy);
    if (denominator > 0) {
      const rawR = Sxy / denominator;
      const clampedR = Math.max(-1, Math.min(1, rawR));
      r = round3(clampedR);
    }
  }

  // 6. Binary significance classification (|r| >= 0.3)
  const hasClearCorrelation = Math.abs(r) >= CORRELATION_SIGNIFICANCE_THRESHOLD;

  return {
    ok: true,
    metricTypeA,
    metricTypeB,
    displayNameA: enrichedA.displayName,
    displayNameB: enrichedB.displayName,
    unitA: enrichedA.unit || undefined,
    unitB: enrichedB.unit || undefined,
    windowDays,
    windowStart: startTime.toISOString(),
    windowEnd: endTime.toISOString(),
    sampleSize,
    correlationCoefficient: r,
    hasClearCorrelation,
    pairedDailyAverages,
  };
}
