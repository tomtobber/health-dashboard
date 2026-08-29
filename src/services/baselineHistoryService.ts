import { db } from '../db';
import { metricBaselineHistory, metricEntries, metricDefinitions } from '../db/schema';
import { and, eq, gte, lte, isNull, asc, sql } from 'drizzle-orm';
import { computeMetricBaseline, BASELINE_HISTORY_WINDOW_DAYS, MIN_BASELINE_SAMPLE_SIZE } from './baselineService';
import { getCanonicalProviderMetricMetadata } from '../adapters/baseAdapter';
import { DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';

export { BASELINE_HISTORY_WINDOW_DAYS };
export const MIN_BASELINE_HISTORY_SAMPLE_SIZE = MIN_BASELINE_SAMPLE_SIZE;
export const MAX_SNAPSHOTS_PER_REFRESH = 50;

export interface BaselineHistoryItem {
  id: string;
  userId: string;
  metricType: string;
  computedAt: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  sampleSize: number;
  createdAt: string;
}

export interface BaselineHistoryRefreshSummary {
  metricsProcessed: number;
  snapshotsAdded: number;
  snapshotsSkippedExisting: number;
  snapshotsSkippedInsufficientData: number;
  metricsSkippedNonApplicable: Array<{
    metricType: string;
    reason: 'non_applicable_type';
    valueType: string;
  }>;
  hasMore: boolean;
}

/**
 * Returns fully-elapsed UTC calendar-month boundaries between earliest entry and now.
 * Excludes the current, in-progress calendar month.
 * Each boundary represents 00:00:00.000Z on the 1st of the month.
 */
export function getFullyElapsedMonthBoundaries(earliestDate: Date, now: Date = new Date()): Date[] {
  const latestBoundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  
  // Earliest boundary is the 1st of the month immediately following earliestDate
  let cursor = new Date(Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth() + 1, 1, 0, 0, 0, 0));

  const boundaries: Date[] = [];
  while (cursor.getTime() <= latestBoundary.getTime()) {
    boundaries.push(new Date(cursor.getTime()));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }

  return boundaries;
}

/**
 * Resolves valueType for a given metric (checking custom DB definitions, or standard provider metadata).
 */
async function resolveMetricValueType(userId: string, metricType: string): Promise<string> {
  try {
    const custom = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.userId, userId), eq(metricDefinitions.metricType, metricType)))
      .limit(1);

    if (custom.length > 0 && custom[0]) {
      return custom[0].valueType;
    }
  } catch (err: unknown) {
    logger.warn('Failed to query custom metric definition for valueType resolution', {
      operation: 'resolveMetricValueType',
      userId,
      metricType,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const std = getCanonicalProviderMetricMetadata(metricType);
  return std.valueType;
}

/**
 * Iterates eligible numeric/duration metrics for a user and generates monthly baseline snapshots.
 * Bounded per call to MAX_SNAPSHOTS_PER_REFRESH to guarantee execution within request timeouts.
 */
export async function refreshBaselineHistory(
  userId: string,
  options?: { maxSnapshots?: number; now?: Date }
): Promise<BaselineHistoryRefreshSummary> {
  const maxSnapshots = options?.maxSnapshots ?? MAX_SNAPSHOTS_PER_REFRESH;
  const now = options?.now ?? new Date();

  let distinctMetricRows: Array<{ metricType: string }>;
  try {
    distinctMetricRows = await db
      .selectDistinct({ metricType: metricEntries.metricType })
      .from(metricEntries)
      .where(and(eq(metricEntries.userId, userId), isNull(metricEntries.deletedAt)));
  } catch (err: unknown) {
    logger.error('Failed to query distinct metric types for baseline history refresh', {
      operation: 'refreshBaselineHistory',
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to query metrics for baseline history refresh',
      { operation: 'refreshBaselineHistory', userId },
      err
    );
  }

  let metricsProcessed = 0;
  let snapshotsAdded = 0;
  let snapshotsSkippedExisting = 0;
  let snapshotsSkippedInsufficientData = 0;
  let hasMore = false;
  let evaluatedSnapshotsCount = 0;
  const metricsSkippedNonApplicable: Array<{
    metricType: string;
    reason: 'non_applicable_type';
    valueType: string;
  }> = [];

  for (const { metricType } of distinctMetricRows) {
    if (evaluatedSnapshotsCount >= maxSnapshots) {
      hasMore = true;
      break;
    }

    const valueType = await resolveMetricValueType(userId, metricType);
    if (valueType !== 'numeric' && valueType !== 'duration') {
      metricsSkippedNonApplicable.push({
        metricType,
        reason: 'non_applicable_type',
        valueType,
      });
      continue;
    }

    // Find earliest entry timestamp for this metric
    let minStartRows: Array<{ minStart: Date | null }>;
    try {
      minStartRows = await db
        .select({
          minStart: sql`MIN(${metricEntries.startTime})`.mapWith((v) => (v ? new Date(v) : null)),
        })
        .from(metricEntries)
        .where(
          and(
            eq(metricEntries.userId, userId),
            eq(metricEntries.metricType, metricType),
            isNull(metricEntries.deletedAt)
          )
        );
    } catch (err: unknown) {
      logger.error('Failed to query earliest metric entry for baseline history', {
        operation: 'refreshBaselineHistory:earliest',
        userId,
        metricType,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new DatabaseError(
        'Failed to query earliest metric entry for baseline history',
        { operation: 'refreshBaselineHistory:earliest', userId, metricType },
        err
      );
    }

    const earliestDate = minStartRows[0]?.minStart;
    if (!earliestDate) continue;

    metricsProcessed++;
    const boundaries = getFullyElapsedMonthBoundaries(earliestDate, now);
    if (boundaries.length === 0) continue;

    // Query already computed snapshots for this metric
    let existingRows: Array<{ computedAt: Date }>;
    try {
      existingRows = await db
        .select({ computedAt: metricBaselineHistory.computedAt })
        .from(metricBaselineHistory)
        .where(
          and(
            eq(metricBaselineHistory.userId, userId),
            eq(metricBaselineHistory.metricType, metricType)
          )
        );
    } catch (err: unknown) {
      logger.error('Failed to query existing baseline history snapshots', {
        operation: 'refreshBaselineHistory:existing',
        userId,
        metricType,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new DatabaseError(
        'Failed to query existing baseline history snapshots',
        { operation: 'refreshBaselineHistory:existing', userId, metricType },
        err
      );
    }

    const existingTimestamps = new Set(existingRows.map((r) => r.computedAt.getTime()));

    for (const boundary of boundaries) {
      if (existingTimestamps.has(boundary.getTime())) {
        snapshotsSkippedExisting++;
        continue;
      }

      if (evaluatedSnapshotsCount >= maxSnapshots) {
        hasMore = true;
        break;
      }

      evaluatedSnapshotsCount++;

      // Compute baseline snapshot as of boundary
      const snapshot = await computeMetricBaseline(userId, metricType, {
        windowDays: BASELINE_HISTORY_WINDOW_DAYS,
        asOf: boundary,
      });

      if (snapshot.ok) {
        try {
          const inserted = await db
            .insert(metricBaselineHistory)
            .values({
              userId,
              metricType,
              computedAt: boundary,
              windowDays: BASELINE_HISTORY_WINDOW_DAYS,
              windowStart: new Date(snapshot.windowStart),
              windowEnd: new Date(snapshot.windowEnd),
              mean: snapshot.mean,
              stddev: snapshot.stddev,
              min: snapshot.min,
              max: snapshot.max,
              sampleSize: snapshot.sampleSize,
            })
            .onConflictDoNothing({
              target: [
                metricBaselineHistory.userId,
                metricBaselineHistory.metricType,
                metricBaselineHistory.computedAt,
              ],
            })
            .returning({ id: metricBaselineHistory.id });

          if (inserted.length > 0) {
            snapshotsAdded++;
          } else {
            snapshotsSkippedExisting++;
          }
        } catch (err: unknown) {
          logger.error('Failed to insert baseline history snapshot', {
            operation: 'refreshBaselineHistory:insert',
            userId,
            metricType,
            computedAt: boundary.toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
          throw new DatabaseError(
            'Failed to insert baseline history snapshot',
            { operation: 'refreshBaselineHistory:insert', userId, metricType },
            err
          );
        }
      } else {
        snapshotsSkippedInsufficientData++;
      }
    }
  }

  logger.info('Baseline history refresh completed', {
    operation: 'refreshBaselineHistory',
    userId,
    metricsProcessed,
    snapshotsAdded,
    snapshotsSkippedExisting,
    snapshotsSkippedInsufficientData,
    nonApplicableCount: metricsSkippedNonApplicable.length,
    hasMore,
  });

  return {
    metricsProcessed,
    snapshotsAdded,
    snapshotsSkippedExisting,
    snapshotsSkippedInsufficientData,
    metricsSkippedNonApplicable,
    hasMore,
  };
}

/**
 * Returns stored chronological baseline snapshots for a given user and metric.
 */
export async function getMetricBaselineHistory(
  userId: string,
  metricType: string,
  options?: { startTime?: Date; endTime?: Date }
): Promise<BaselineHistoryItem[]> {
  const conditions = [
    eq(metricBaselineHistory.userId, userId),
    eq(metricBaselineHistory.metricType, metricType),
  ];

  if (options?.startTime) {
    conditions.push(gte(metricBaselineHistory.computedAt, options.startTime));
  }
  if (options?.endTime) {
    conditions.push(lte(metricBaselineHistory.computedAt, options.endTime));
  }

  try {
    const rows = await db
      .select()
      .from(metricBaselineHistory)
      .where(and(...conditions))
      .orderBy(asc(metricBaselineHistory.computedAt));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      metricType: r.metricType,
      computedAt: r.computedAt.toISOString(),
      windowDays: r.windowDays,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      mean: r.mean,
      stddev: r.stddev,
      min: r.min,
      max: r.max,
      sampleSize: r.sampleSize,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (err: unknown) {
    logger.error('Failed to query baseline history', {
      operation: 'getMetricBaselineHistory',
      userId,
      metricType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to query baseline history',
      { operation: 'getMetricBaselineHistory', userId, metricType },
      err
    );
  }
}
