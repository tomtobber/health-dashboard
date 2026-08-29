import { bucketToDailyMeans } from '../utils/dailyBucketing';
import { z } from 'zod';
import { db } from '../db';
import { metricBaselineConfigs } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { queryEnrichedMetricEntries } from './metricsQueryService';
import { DatabaseError, ValidationError } from '../errors/AppError';
import { logger } from '../utils/logger';

export const DEFAULT_BASELINE_WINDOW_DAYS = 90;
export const BASELINE_HISTORY_WINDOW_DAYS = 90;
export const MIN_BASELINE_SAMPLE_SIZE = 10;
export const MIN_BASELINE_WINDOW_DAYS = 7;
export const MAX_BASELINE_WINDOW_DAYS = 3650;

export const MIN_TREND_SAMPLE_SIZE = 10;
export const TREND_CORRELATION_THRESHOLD = 0.3;

export const BaselineWindowSchema = z.object({
  windowDays: z.coerce.number().int().min(MIN_BASELINE_WINDOW_DAYS, {
    message: `windowDays must be at least ${MIN_BASELINE_WINDOW_DAYS}`,
  }).max(MAX_BASELINE_WINDOW_DAYS, {
    message: `windowDays cannot exceed ${MAX_BASELINE_WINDOW_DAYS}`,
  }),
});

export type BaselineResult =
  | {
      ok: true;
      metricType: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      mean: number;
      stddev: number;
      min: number;
      max: number;
      displayName: string;
      unit?: string;
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricType: string;
      displayName: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };

export type TrendResult =
  | {
      ok: true;
      metricType: string;
      displayName: string;
      unit?: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      direction: 'increasing' | 'decreasing' | 'no_clear_trend';
      slopePerDay: number;
      correlationCoefficient: number;
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricType: string;
      displayName: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };

export type BaselineConfigResult =
  | { configured: true; metricType: string; windowDays: number }
  | { configured: false; metricType: string; default: number };

function round2(val: number): number {
  const res = Math.round((val + Number.EPSILON) * 100) / 100;
  return Object.is(res, -0) ? 0 : res;
}

export function round3(val: number): number {
  const res = Math.round((val + Number.EPSILON) * 1000) / 1000;
  return Object.is(res, -0) ? 0 : res;
}

export interface BaselineStatsComputeOptions {
  windowDays: number;
  asOf?: Date;
}

export async function computeMetricBaseline(
  userId: string,
  metricType: string,
  options: BaselineStatsComputeOptions
): Promise<BaselineResult> {
  const asOf = options.asOf || new Date();
  const windowDays = options.windowDays;
  const startTime = new Date(asOf.getTime() - windowDays * 86400000);
  const endTime = asOf;

  const enriched = await queryEnrichedMetricEntries({
    userId,
    metricType,
    startTime,
    endTime,
  });

  if (enriched.valueType !== 'numeric' && enriched.valueType !== 'duration') {
    throw new ValidationError(
      `Baseline computation is only supported for numeric or duration metrics, received '${enriched.valueType}'`,
      {
        operation: 'computeMetricBaseline',
        userId,
        metricType,
        valueType: enriched.valueType,
      }
    );
  }

  const values: number[] = [];
  for (const entry of enriched.entries) {
    if (typeof entry.valueNumeric === 'number' && !isNaN(entry.valueNumeric)) {
      values.push(entry.valueNumeric);
    }
  }

  if (values.length < MIN_BASELINE_SAMPLE_SIZE) {
    return {
      ok: false,
      reason: 'insufficient_data',
      metricType: enriched.metricType,
      displayName: enriched.displayName,
      windowDays,
      sampleSize: values.length,
      minRequired: MIN_BASELINE_SAMPLE_SIZE,
    };
  }

  const sampleSize = values.length;
  const sum = values.reduce((acc, val) => acc + val, 0);
  const mean = sum / sampleSize;

  const sumSquaredDiff = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
  const variance = sumSquaredDiff / (sampleSize - 1);
  const stddev = Math.sqrt(variance);

  const min = Math.min(...values);
  const max = Math.max(...values);

  return {
    ok: true,
    metricType: enriched.metricType,
    windowDays,
    windowStart: startTime.toISOString(),
    windowEnd: endTime.toISOString(),
    sampleSize,
    mean: round2(mean),
    stddev: round2(stddev),
    min: round2(min),
    max: round2(max),
    displayName: enriched.displayName,
    unit: enriched.unit || undefined,
  };
}

export async function getMetricBaseline(
  userId: string,
  metricType: string,
  windowDaysOverride?: number,
  asOf?: Date
): Promise<BaselineResult> {
  let windowDays = DEFAULT_BASELINE_WINDOW_DAYS;

  if (windowDaysOverride !== undefined) {
    const parsed = BaselineWindowSchema.parse({ windowDays: windowDaysOverride });
    windowDays = parsed.windowDays;
  } else {
    try {
      const configRows = await db
        .select()
        .from(metricBaselineConfigs)
        .where(
          and(
            eq(metricBaselineConfigs.userId, userId),
            eq(metricBaselineConfigs.metricType, metricType)
          )
        )
        .limit(1);

      if (configRows.length > 0 && configRows[0]) {
        windowDays = configRows[0].windowDays;
      }
    } catch (err: unknown) {
      logger.error('Failed to query metric baseline config', {
        operation: 'getMetricBaseline',
        userId,
        metricType,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new DatabaseError(
        'Failed to query metric baseline configuration',
        { operation: 'getMetricBaseline', userId, metricType },
        err
      );
    }
  }

  return computeMetricBaseline(userId, metricType, {
    windowDays,
    asOf: asOf || new Date(),
  });
}

export async function getMetricTrend(
  userId: string,
  metricType: string,
  windowDaysOverride?: number
): Promise<TrendResult> {
  let windowDays = DEFAULT_BASELINE_WINDOW_DAYS;

  if (windowDaysOverride !== undefined) {
    const parsed = BaselineWindowSchema.parse({ windowDays: windowDaysOverride });
    windowDays = parsed.windowDays;
  } else {
    try {
      const configRows = await db
        .select()
        .from(metricBaselineConfigs)
        .where(
          and(
            eq(metricBaselineConfigs.userId, userId),
            eq(metricBaselineConfigs.metricType, metricType)
          )
        )
        .limit(1);

      if (configRows.length > 0 && configRows[0]) {
        windowDays = configRows[0].windowDays;
      }
    } catch (err: unknown) {
      logger.error('Failed to query metric baseline config for trend', {
        operation: 'getMetricTrend',
        userId,
        metricType,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new DatabaseError(
        'Failed to query metric baseline configuration for trend',
        { operation: 'getMetricTrend', userId, metricType },
        err
      );
    }
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - windowDays * 86400000);
  const endTime = now;

  const enriched = await queryEnrichedMetricEntries({
    userId,
    metricType,
    startTime,
    endTime,
  });

  if (enriched.valueType !== 'numeric' && enriched.valueType !== 'duration') {
    throw new ValidationError(
      `Trend computation is only supported for numeric or duration metrics, received '${enriched.valueType}'`,
      {
        operation: 'getMetricTrend',
        userId,
        metricType,
        valueType: enriched.valueType,
      }
    );
  }

  const dailyMeans = bucketToDailyMeans(enriched.entries);
  const sampleSize = dailyMeans.size;

  if (sampleSize < MIN_TREND_SAMPLE_SIZE) {
    return {
      ok: false,
      reason: 'insufficient_data',
      metricType: enriched.metricType,
      displayName: enriched.displayName,
      windowDays,
      sampleSize,
      minRequired: MIN_TREND_SAMPLE_SIZE,
    };
  }

  const sortedDays = Array.from(dailyMeans.keys()).sort();
  const windowStartMs = startTime.getTime();
  const points: { x: number; y: number }[] = [];

  for (const dayKey of sortedDays) {
    const d = dailyMeans.get(dayKey);
    if (!d) continue;
    const daysFromStart = (d.dateUtcMs - windowStartMs) / 86400000;
    points.push({ x: daysFromStart, y: d.mean });
  }

  const N = points.length;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / N;
  const meanY = sumY / N;

  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    Sxx += dx * dx;
    Syy += dy * dy;
    Sxy += dx * dy;
  }

  let slope = 0;
  let r = 0;
  let direction: 'increasing' | 'decreasing' | 'no_clear_trend' = 'no_clear_trend';

  if (Sxx > 0 && Syy > 0) {
    slope = Sxy / Sxx;
    r = Sxy / Math.sqrt(Sxx * Syy);

    if (Math.abs(r) >= TREND_CORRELATION_THRESHOLD) {
      if (slope > 0) {
        direction = 'increasing';
      } else if (slope < 0) {
        direction = 'decreasing';
      }
    }
  }

  return {
    ok: true,
    metricType: enriched.metricType,
    displayName: enriched.displayName,
    unit: enriched.unit || undefined,
    windowDays,
    windowStart: startTime.toISOString(),
    windowEnd: endTime.toISOString(),
    sampleSize,
    direction,
    slopePerDay: round3(slope),
    correlationCoefficient: round3(r),
  };
}

export async function getBaselineConfig(
  userId: string,
  metricType: string
): Promise<BaselineConfigResult> {
  try {
    const configRows = await db
      .select()
      .from(metricBaselineConfigs)
      .where(
        and(
          eq(metricBaselineConfigs.userId, userId),
          eq(metricBaselineConfigs.metricType, metricType)
        )
      )
      .limit(1);

    if (configRows.length > 0 && configRows[0]) {
      return {
        configured: true,
        metricType,
        windowDays: configRows[0].windowDays,
      };
    }

    return {
      configured: false,
      metricType,
      default: DEFAULT_BASELINE_WINDOW_DAYS,
    };
  } catch (err: unknown) {
    logger.error('Failed to get baseline config', {
      operation: 'getBaselineConfig',
      userId,
      metricType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to get baseline config',
      { operation: 'getBaselineConfig', userId, metricType },
      err
    );
  }
}

export async function setBaselineConfig(
  userId: string,
  metricType: string,
  rawWindowDays: unknown
): Promise<BaselineConfigResult> {
  const parsed = BaselineWindowSchema.parse({ windowDays: rawWindowDays });
  const windowDays = parsed.windowDays;

  const now = new Date();
  const enriched = await queryEnrichedMetricEntries({
    userId,
    metricType,
    startTime: new Date(now.getTime() - 86400000),
    endTime: now,
  });

  if (enriched.valueType !== 'numeric' && enriched.valueType !== 'duration') {
    throw new ValidationError(
      `Baseline configuration is only supported for numeric or duration metrics, received '${enriched.valueType}'`,
      {
        operation: 'setBaselineConfig',
        userId,
        metricType,
        valueType: enriched.valueType,
      }
    );
  }

  try {
    await db
      .insert(metricBaselineConfigs)
      .values({
        userId,
        metricType,
        windowDays,
      })
      .onConflictDoUpdate({
        target: [metricBaselineConfigs.userId, metricBaselineConfigs.metricType],
        set: {
          windowDays,
          updatedAt: new Date(),
        },
      });

    return {
      configured: true,
      metricType,
      windowDays,
    };
  } catch (err: unknown) {
    logger.error('Failed to set baseline config', {
      operation: 'setBaselineConfig',
      userId,
      metricType,
      windowDays,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to set baseline configuration',
      { operation: 'setBaselineConfig', userId, metricType, windowDays },
      err
    );
  }
}
