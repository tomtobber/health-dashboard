import { NormalizedMetricEntry, getCanonicalProviderMetricMetadata } from '../adapters/baseAdapter';
import { db, pool } from '../db';
import { metricEntries, metricDefinitions } from '../db/schema';
import { and, eq, gte, lte, isNull, inArray } from 'drizzle-orm';
import { DatabaseError, ValidationError } from '../errors/AppError';
import { isStepsMetric } from './baselineService';

export interface MetricQueryFilter {
  userId: string;
  metricType: string;
  startTime: Date;
  endTime: Date;
  dimension?: string;
  aggregation?: string;
}

export interface BatchMetricQueryFilter {
  userId: string;
  metricTypes: string[];
  startTime: Date;
  endTime: Date;
  dimension?: string;
  aggregation?: string;
}

export interface MetricEntryWithDelete extends NormalizedMetricEntry {
  deletedAt?: Date | null;
}

export interface EnrichedMetricQueryResult {
  metricType: string;
  displayName: string;
  valueType: 'numeric' | 'duration' | 'boolean' | 'category';
  unit: string | null;
  categoryValues: string[] | null;
  isCustom: boolean;
  isArchived: boolean;
  entries: NormalizedMetricEntry[];
}

/**
 * Filter out raw stream entries when a reconciled stream entry covers the identical timestamp window.
 */
export function filterReconciledOverRaw(entries: MetricEntryWithDelete[]): NormalizedMetricEntry[] {
  const activeEntries = entries.filter((e) => !e.deletedAt);

  const reconciledTimeIntervals = new Set<string>();
  for (const entry of activeEntries) {
    if (entry.sourceStream === 'reconciled') {
      const startMs = new Date(entry.startTime).getTime();
      const endMs = new Date(entry.endTime).getTime();
      const dim = entry.dimension || 'default';
      reconciledTimeIntervals.add(`${dim}_${startMs}_${endMs}`);
    }
  }

  const result: NormalizedMetricEntry[] = [];
  for (const entry of activeEntries) {
    const startMs = new Date(entry.startTime).getTime();
    const endMs = new Date(entry.endTime).getTime();
    const dim = entry.dimension || 'default';
    const key = `${dim}_${startMs}_${endMs}`;

    if (entry.sourceStream === 'raw' && reconciledTimeIntervals.has(key)) {
      continue;
    }

    result.push(entry);
  }

  return result;
}

/**
 * Determines whether a metric is cumulative (aggregated by SUM) or continuous (aggregated by AVG).
 */
export function isCumulativeMetric(metricType: string, valueType?: string, unit?: string | null): boolean {
  if (valueType === 'duration') return true;
  if (metricType === 'steps' || metricType === 'sleep' || metricType === 'water-intake' || metricType === 'active-zone-minutes' || metricType === 'distance') {
    return true;
  }
  const u = (unit || '').toLowerCase();
  if (['count', 'reps', 'steps', 'ml', 'fl_oz', 'l', 'kcal', 'cal', 'kJ', 'minutes', 'seconds', 'hours'].includes(u)) {
    return true;
  }
  return false;
}

/**
 * SQL-level Time-Aggregated Query (daily_avg, weekly_avg) for continuous and cumulative metrics.
 * Uses date_trunc on TIMESTAMPTZ (session/UTC timezone matching daily_avg).
 * Dynamically applies SUM vs AVG for daily aggregation, and AVG for weekly_avg.
 */
async function queryAggregatedMetricsFromDb(
  userId: string,
  metricTypes: string[],
  sumMetricTypes: string[],
  startTime: Date,
  endTime: Date,
  dimension?: string,
  targetAggregation = 'daily_avg'
): Promise<Map<string, NormalizedMetricEntry[]>> {
  const isSpecificDimension = Boolean(dimension && dimension.trim());
  const isWeekly = targetAggregation === 'weekly_avg';
  const truncUnit = isWeekly ? 'week' : 'day';

  const queryText = `
    WITH ranked_entries AS (
      SELECT
        id,
        user_id,
        provider,
        metric_type,
        dimension,
        start_time,
        end_time,
        value_numeric,
        value_min,
        value_max,
        unit,
        source_stream,
        aggregation,
        date_trunc('${truncUnit}', start_time) AS time_bucket,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, metric_type, dimension, start_time, end_time
          ORDER BY CASE WHEN source_stream = 'reconciled' THEN 0 ELSE 1 END
        ) as rn
      FROM metric_entries
      WHERE user_id = $1
        AND metric_type = ANY($2::text[])
        AND start_time >= $3
        AND end_time <= $4
        AND deleted_at IS NULL
        ${isSpecificDimension ? 'AND dimension = $7' : "AND (metric_type != 'sleep' OR dimension IN ('summary', 'default'))"}
        AND value_numeric IS NOT NULL
    )
    SELECT
      user_id,
      provider,
      metric_type,
      dimension,
      time_bucket AS start_time,
      (time_bucket + interval '1 ${truncUnit}' - interval '1 millisecond') AS end_time,
      CASE 
        WHEN NOT ${isWeekly} AND metric_type = ANY($6::text[])
          THEN ROUND(SUM(value_numeric)::numeric, 2)::double precision
        ELSE
          ROUND(AVG(value_numeric)::numeric, 2)::double precision
      END AS value_numeric,
      ROUND(MIN(COALESCE(value_min, value_numeric))::numeric, 2)::double precision AS value_min,
      ROUND(MAX(COALESCE(value_max, value_numeric))::numeric, 2)::double precision AS value_max,
      MAX(unit) AS unit,
      $5 AS aggregation
    FROM ranked_entries
    WHERE rn = 1
    GROUP BY user_id, provider, metric_type, dimension, time_bucket
    ORDER BY time_bucket ASC;
  `;

  const queryParams: unknown[] = [userId, metricTypes, startTime, endTime, targetAggregation, sumMetricTypes];
  if (isSpecificDimension) {
    queryParams.push(dimension);
  }

  const client = await pool.connect();
  try {
    // 8-second bounded statement timeout (safely under the 12s client timeout)
    await client.query('SET statement_timeout = 8000');
    const result = await client.query<{
      user_id: string;
      provider: string;
      metric_type: string;
      dimension: string;
      start_time: Date;
      end_time: Date;
      value_numeric: number;
      value_min: number;
      value_max: number;
      unit: string | null;
      aggregation: string;
    }>(queryText, queryParams);

    const resultMap = new Map<string, NormalizedMetricEntry[]>();
    for (const mt of metricTypes) {
      resultMap.set(mt, []);
    }

    for (const row of result.rows) {
      const entry: NormalizedMetricEntry = {
        userId: row.user_id,
        provider: row.provider,
        metricType: row.metric_type,
        startTime: row.start_time,
        endTime: row.end_time,
        valueNumeric: row.value_numeric,
        valueMin: row.value_min,
        valueMax: row.value_max,
        unit: row.unit,
        dimension: row.dimension,
        sourceStream: 'raw',
        aggregation: row.aggregation,
      };
      const list = resultMap.get(row.metric_type);
      if (list) {
        list.push(entry);
      }
    }

    return resultMap;
  } catch (err: unknown) {
    throw new DatabaseError('Failed to execute SQL aggregation query', {
      operation: 'queryAggregatedMetricsFromDb',
      userId,
      metricTypes,
      targetAggregation,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  } finally {
    client.release();
  }
}

/**
 * Standard un-aggregated or sub-daily query selecting only needed scalar columns (never raw_payload).
 */
async function queryScalarMetricEntriesFromDb(
  userId: string,
  metricTypes: string[],
  startTime: Date,
  endTime: Date,
  dimension?: string,
  aggregation?: string
): Promise<Map<string, NormalizedMetricEntry[]>> {
  const whereConditions = [
    eq(metricEntries.userId, userId),
    inArray(metricEntries.metricType, metricTypes),
    gte(metricEntries.startTime, startTime),
    lte(metricEntries.endTime, endTime),
    isNull(metricEntries.deletedAt),
  ];

  if (dimension && dimension.trim()) {
    whereConditions.push(eq(metricEntries.dimension, dimension));
  }

  if (aggregation && aggregation !== 'all' && aggregation !== 'auto' && aggregation !== 'daily_avg' && aggregation !== 'daily_sum' && aggregation !== 'weekly_avg') {
    whereConditions.push(eq(metricEntries.aggregation, aggregation));
  }

  // Explicitly select ONLY necessary scalar columns (NEVER raw_payload)
  const rows = await db
    .select({
      userId: metricEntries.userId,
      provider: metricEntries.provider,
      metricType: metricEntries.metricType,
      externalId: metricEntries.externalId,
      startTime: metricEntries.startTime,
      endTime: metricEntries.endTime,
      valueNumeric: metricEntries.valueNumeric,
      valueText: metricEntries.valueText,
      valueMin: metricEntries.valueMin,
      valueMax: metricEntries.valueMax,
      unit: metricEntries.unit,
      dimension: metricEntries.dimension,
      sourceStream: metricEntries.sourceStream,
      aggregation: metricEntries.aggregation,
      deletedAt: metricEntries.deletedAt,
    })
    .from(metricEntries)
    .where(and(...whereConditions));

  const byMetric = new Map<string, MetricEntryWithDelete[]>();
  for (const mt of metricTypes) {
    byMetric.set(mt, []);
  }

  for (const r of rows) {
    const list = byMetric.get(r.metricType);
    if (list) {
      list.push(r as MetricEntryWithDelete);
    }
  }

  const resultMap = new Map<string, NormalizedMetricEntry[]>();
  for (const mt of metricTypes) {
    const metricRows = byMetric.get(mt) || [];
    resultMap.set(mt, filterReconciledOverRaw(metricRows));
  }

  return resultMap;
}

/**
 * Single-metric query from database.
 * Transparently delegates to SQL daily/weekly aggregation for daily_avg/weekly_avg requests.
 */
export async function queryMetricEntriesFromDb(filter: MetricQueryFilter): Promise<NormalizedMetricEntry[]> {
  try {
    const isWeekly = filter.aggregation === 'weekly_avg';
    const isDaily = filter.aggregation === 'daily_avg' || filter.aggregation === 'daily_sum' || filter.aggregation === 'daily';
    let entriesMap: Map<string, NormalizedMetricEntry[]>;

    if (isWeekly || isDaily) {
      // Resolve cumulative status from metric definition or canonical catalog
      const [def] = await db
        .select()
        .from(metricDefinitions)
        .where(and(eq(metricDefinitions.userId, filter.userId), eq(metricDefinitions.metricType, filter.metricType)));

      const isCumul = def 
        ? isCumulativeMetric(def.metricType, def.valueType, def.unit)
        : isCumulativeMetric(filter.metricType, getCanonicalProviderMetricMetadata(filter.metricType).valueType, getCanonicalProviderMetricMetadata(filter.metricType).unit);

      entriesMap = await queryAggregatedMetricsFromDb(
        filter.userId,
        [filter.metricType],
        (!isWeekly && isCumul) ? [filter.metricType] : [],
        filter.startTime,
        filter.endTime,
        filter.dimension,
        filter.aggregation || (isWeekly ? 'weekly_avg' : 'daily_avg')
      );
    } else {
      entriesMap = await queryScalarMetricEntriesFromDb(
        filter.userId,
        [filter.metricType],
        filter.startTime,
        filter.endTime,
        filter.dimension,
        filter.aggregation
      );
    }

    return entriesMap.get(filter.metricType) || [];
  } catch (err: unknown) {
    throw new DatabaseError('Failed to query metric entries from database', {
      operation: 'queryMetricEntriesFromDb',
      filter,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

/**
 * Enriched single-metric query resolving display_name, value_type, unit, and category_values.
 * Resolves aggregation identically to batch query.
 */
export async function queryEnrichedMetricEntries(filter: MetricQueryFilter): Promise<EnrichedMetricQueryResult> {
  const batchResult = await queryBatchEnrichedMetrics({
    userId: filter.userId,
    metricTypes: [filter.metricType],
    startTime: filter.startTime,
    endTime: filter.endTime,
    dimension: filter.dimension,
    aggregation: filter.aggregation,
  });

  return batchResult[0];
}

/**
 * Batch enriched metric query eliminating N+1 lookups for multi-metric dashboard views.
 * Handles both SQL daily/weekly aggregation and scalar stream queries with explicit column selection.
 */
export async function queryBatchEnrichedMetrics(filter: BatchMetricQueryFilter): Promise<EnrichedMetricQueryResult[]> {
  const { userId, metricTypes, startTime, endTime, dimension, aggregation } = filter;

  if (!Array.isArray(metricTypes) || metricTypes.length === 0) {
    throw new ValidationError('metricTypes must be a non-empty array', {
      operation: 'queryBatchEnrichedMetrics',
      userId,
      metricTypes,
    });
  }

  try {
    // 1. Batch definition lookup (no archived_at filter!)
    const definitions = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.userId, userId), inArray(metricDefinitions.metricType, metricTypes)));

    const defMap = new Map<string, typeof definitions[0]>();
    for (const d of definitions) {
      defMap.set(d.metricType, d);
    }

    // 2. Identify cumulative metrics for dynamic SUM vs AVG aggregation
    const sumMetricTypes: string[] = [];
    for (const mt of metricTypes) {
      const def = defMap.get(mt);
      if (def) {
        if (isCumulativeMetric(def.metricType, def.valueType, def.unit)) {
          sumMetricTypes.push(mt);
        }
      } else {
        const canonical = getCanonicalProviderMetricMetadata(mt);
        if (isCumulativeMetric(mt, canonical.valueType, canonical.unit)) {
          sumMetricTypes.push(mt);
        }
      }
    }

    // 3. Query entries
    const isWeekly = aggregation === 'weekly_avg';
    const isDaily = aggregation === 'daily_avg' || aggregation === 'daily_sum' || aggregation === 'daily';
    let entriesByMetric: Map<string, NormalizedMetricEntry[]>;

    if (isWeekly || isDaily) {
      const stepsTypes = metricTypes.filter((mt) => isStepsMetric(mt));
      const otherTypes = metricTypes.filter((mt) => !isStepsMetric(mt));

      if (isWeekly && stepsTypes.length > 0) {
        // Steps metric values are always aggregated as steps per day
        const [otherMap, stepsMap] = await Promise.all([
          otherTypes.length > 0
            ? queryAggregatedMetricsFromDb(
                userId,
                otherTypes,
                [],
                startTime,
                endTime,
                dimension,
                'weekly_avg'
              )
            : Promise.resolve(new Map<string, NormalizedMetricEntry[]>()),
          queryAggregatedMetricsFromDb(
            userId,
            stepsTypes,
            stepsTypes,
            startTime,
            endTime,
            dimension,
            'daily_avg'
          ),
        ]);

        entriesByMetric = new Map<string, NormalizedMetricEntry[]>();
        for (const [k, v] of otherMap.entries()) entriesByMetric.set(k, v);
        for (const [k, v] of stepsMap.entries()) entriesByMetric.set(k, v);
      } else {
        entriesByMetric = await queryAggregatedMetricsFromDb(
          userId,
          metricTypes,
          (!isWeekly ? sumMetricTypes : []),
          startTime,
          endTime,
          dimension,
          aggregation || (isWeekly ? 'weekly_avg' : 'daily_avg')
        );
      }
    } else {
      entriesByMetric = await queryScalarMetricEntriesFromDb(
        userId,
        metricTypes,
        startTime,
        endTime,
        dimension,
        aggregation
      );
    }

    // 4. Assemble enriched results
    const results: EnrichedMetricQueryResult[] = [];

    for (const mt of metricTypes) {
      const def = defMap.get(mt);
      const entries = entriesByMetric.get(mt) || [];

      if (def) {
        results.push({
          metricType: def.metricType,
          displayName: def.displayName,
          valueType: def.valueType as 'numeric' | 'duration' | 'boolean' | 'category',
          unit: def.unit,
          categoryValues: (def.categoryValues as string[]) || null,
          isCustom: true,
          isArchived: Boolean(def.archivedAt),
          entries,
        });
      } else {
        const canonical = getCanonicalProviderMetricMetadata(mt);
        results.push({
          metricType: mt,
          displayName: canonical.displayName,
          valueType: canonical.valueType,
          unit: canonical.unit,
          categoryValues: canonical.categoryValues || null,
          isCustom: false,
          isArchived: false,
          entries,
        });
      }
    }

    return results;
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      throw err;
    }
    throw new DatabaseError('Failed to batch query enriched metrics', {
      operation: 'queryBatchEnrichedMetrics',
      userId,
      metricTypes,
      aggregation,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}
