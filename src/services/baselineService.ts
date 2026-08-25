import { z } from 'zod';
import { db } from '../db';
import { metricBaselineConfigs } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { queryEnrichedMetricEntries } from './metricsQueryService';
import { DatabaseError, ValidationError } from '../errors/AppError';
import { logger } from '../utils/logger';

export const DEFAULT_BASELINE_WINDOW_DAYS = 90;
export const MIN_BASELINE_SAMPLE_SIZE = 10;
export const MIN_BASELINE_WINDOW_DAYS = 7;
export const MAX_BASELINE_WINDOW_DAYS = 3650;

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
      sampleSize: number;
      minRequired: number;
    };

export type BaselineConfigResult =
  | { configured: true; metricType: string; windowDays: number }
  | { configured: false; metricType: string; default: number };

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Retrieve personal baseline statistics for a numeric or duration metric over a rolling window.
 *
 * Decisions:
 * 1. Rolling trailing window (now - windowDays to now) reflects the user's historical state
 *    continuously up to right now, without calendar boundary lag.
 * 2. Sample standard deviation uses Bessel's correction (N - 1) because the recorded entries
 *    are a sample of the user's ongoing physiological state, providing an unbiased estimator.
 */
export async function getMetricBaseline(
  userId: string,
  metricType: string,
  windowDaysOverride?: number
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
      `Baseline computation is only supported for numeric or duration metrics, received '${enriched.valueType}'`,
      {
        operation: 'getMetricBaseline',
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
      sampleSize: values.length,
      minRequired: MIN_BASELINE_SAMPLE_SIZE,
    };
  }

  const sampleSize = values.length;
  const sum = values.reduce((acc, val) => acc + val, 0);
  const mean = sum / sampleSize;

  // Sample standard deviation with Bessel's correction (N - 1)
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

/**
 * Retrieve saved baseline window configuration for a given metric, or default (90 days).
 */
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

/**
 * Upsert saved baseline window configuration for a given metric.
 */
export async function setBaselineConfig(
  userId: string,
  metricType: string,
  rawWindowDays: unknown
): Promise<BaselineConfigResult> {
  const parsed = BaselineWindowSchema.parse({ windowDays: rawWindowDays });
  const windowDays = parsed.windowDays;

  // Validate that the metric exists and is numeric or duration
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
