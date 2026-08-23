import { NormalizedMetricEntry, getCanonicalProviderMetricMetadata } from '../adapters/baseAdapter';
import { db, pool } from '../db';
import { metricEntries, metricDefinitions } from '../db/schema';
import { and, eq, gte, lte, isNull, inArray } from 'drizzle-orm';
import { DatabaseError, ValidationError } from '../errors/AppError';

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

export function filterReconciledOverRaw(entries: MetricEntryWithDelete[]): NormalizedMetricEntry[] {
  const activeEntries = entries.filter((e) => !e.deletedAt);

  const reconciledMap = new Map<string, NormalizedMetricEntry>();
  const rawEntries: NormalizedMetricEntry[] = [];

  for (const entry of activeEntries) {
    const dim = entry.dimension || 'default';
    if (entry.sourceStream === 'reconciled') {
      const key = `${dim}_${entry.startTime.toISOString()}-${entry.endTime.toISOString()}`;
      reconciledMap.set(key, entry);
    } else {
      rawEntries.push(entry);
    }
  }

  const result: NormalizedMetricEntry[] = Array.from(reconciledMap.values());

  for (const raw of rawEntries) {
    const dim = raw.dimension || 'default';
    const rawKey = `${dim}_${raw.startTime.toISOString()}-${raw.endTime.toISOString()}`;
    if (!reconciledMap.has(rawKey)) {
      result.push(raw);
    }
  }

  return result.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/**
 * SQL-level Daily Aggregation Query for continuous and cumulative metrics.
 * Executes in Postgres, returning exactly 1 row per distinct calendar day per metric/dimension.
 */
async function queryDailyAggregatedMetricsFromDb(
  userId: string,
  metricTypes: string[],
  startTime: Date,
  endTime: Date,
  dimension?: string,
  targetAggregation = 'daily_avg'
): Promise<Map<string, NormalizedMetricEntry[]>> {
  const isSpecificDimension = Boolean(dimension && dimension.trim());

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
        date_trunc('day', start_time) AS day_bucket,
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
        ${isSpecificDimension ? 'AND dimension = $6' : "AND (metric_type != 'sleep' OR dimension IN ('summary', 'default'))"}
        AND value_numeric IS NOT NULL
    )
    SELECT
      user_id,
      provider,
      metric_type,
      dimension,
      day_bucket AS start_time,
      (day_bucket + interval '1 day' - interval '1 millisecond') AS end_time,
      CASE 
        WHEN metric_type IN ('steps', 'water-intake', 'hydration-log', 'sleep', 'total-calories')
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
    GROUP BY user_id, provider, metric_type, dimension, day_bucket
    ORDER BY day_bucket ASC;
  `;

  const queryParams: unknown[] = [userId, metricTypes, startTime, endTime, targetAggregation];
  if (isSpecificDimension) {
    queryParams.push(dimension);
  }

  const client = await pool.connect();
  try {
    // Set explicit bounded statement timeout (15 seconds)
    await client.query('SET statement_timeout = 15000');
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
      const list = resultMap.get(row.metric_type);
      if (list) {
        list.push({
          userId: row.user_id,
          provider: row.provider,
          metricType: row.metric_type,
          startTime: new Date(row.start_time),
          endTime: new Date(row.end_time),
          valueNumeric: row.value_numeric,
          valueMin: row.value_min,
          valueMax: row.value_max,
          unit: row.unit,
          dimension: row.dimension,
          aggregation: row.aggregation,
        });
      }
    }

    return resultMap;
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

  if (dimension) {
    whereConditions.push(eq(metricEntries.dimension, dimension));
  }

  if (aggregation && aggregation !== 'all' && aggregation !== 'auto' && aggregation !== 'daily_avg' && aggregation !== 'daily_sum') {
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

  const rowsByMetric = new Map<string, MetricEntryWithDelete[]>();
  for (const mt of metricTypes) {
    rowsByMetric.set(mt, []);
  }

  for (const row of rows) {
    const list = rowsByMetric.get(row.metricType);
    if (list) {
      list.push({
        userId: row.userId,
        provider: row.provider,
        metricType: row.metricType,
        externalId: row.externalId || undefined,
        startTime: row.startTime,
        endTime: row.endTime,
        valueNumeric: row.valueNumeric ?? undefined,
        valueText: row.valueText ?? undefined,
        valueMin: row.valueMin ?? undefined,
        valueMax: row.valueMax ?? undefined,
        unit: row.unit,
        dimension: row.dimension,
        sourceStream: row.sourceStream as 'raw' | 'reconciled' | null | undefined,
        aggregation: row.aggregation,
        deletedAt: row.deletedAt,
      });
    }
  }

  const resultMap = new Map<string, NormalizedMetricEntry[]>();
  for (const mt of metricTypes) {
    const metricRows = rowsByMetric.get(mt) || [];
    resultMap.set(mt, filterReconciledOverRaw(metricRows));
  }

  return resultMap;
}

export async function queryMetricEntriesFromDb(filter: MetricQueryFilter): Promise<NormalizedMetricEntry[]> {
  try {
    const isDaily = filter.aggregation === 'daily_avg' || filter.aggregation === 'daily_sum' || filter.aggregation === 'daily';
    let entriesMap: Map<string, NormalizedMetricEntry[]>;

    if (isDaily) {
      entriesMap = await queryDailyAggregatedMetricsFromDb(
        filter.userId,
        [filter.metricType],
        filter.startTime,
        filter.endTime,
        filter.dimension,
        filter.aggregation || 'daily_avg'
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
 * Handles both SQL daily aggregation and scalar stream queries with explicit column selection.
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

    // 2. Query entries (SQL daily aggregation if daily, else scalar selection)
    const isDaily = aggregation === 'daily_avg' || aggregation === 'daily_sum' || aggregation === 'daily';
    let entriesByMetric: Map<string, NormalizedMetricEntry[]>;

    if (isDaily) {
      entriesByMetric = await queryDailyAggregatedMetricsFromDb(
        userId,
        metricTypes,
        startTime,
        endTime,
        dimension,
        aggregation || 'daily_avg'
      );
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

    // 3. Assemble enriched results for all requested metricTypes
    const results: EnrichedMetricQueryResult[] = [];

    for (const mt of metricTypes) {
      const def = defMap.get(mt);
      let displayName: string;
      let valueType: 'numeric' | 'duration' | 'boolean' | 'category';
      let unit: string | null;
      let categoryValues: string[] | null;
      let isCustom: boolean;
      let isArchived: boolean;

      if (def) {
        displayName = def.displayName;
        valueType = def.valueType as 'numeric' | 'duration' | 'boolean' | 'category';
        unit = def.unit;
        categoryValues = def.categoryValues;
        isCustom = true;
        isArchived = def.archivedAt !== null;
      } else {
        const canonical = getCanonicalProviderMetricMetadata(mt);
        displayName = canonical.displayName;
        valueType = canonical.valueType;
        unit = canonical.unit;
        categoryValues = canonical.categoryValues || null;
        isCustom = false;
        isArchived = false;
      }

      const entries = entriesByMetric.get(mt) || [];

      results.push({
        metricType: mt,
        displayName,
        valueType,
        unit,
        categoryValues,
        isCustom,
        isArchived,
        entries,
      });
    }

    return results;
  } catch (err: unknown) {
    if (err instanceof ValidationError) throw err;
    throw new DatabaseError('Failed to query batch enriched metrics', {
      operation: 'queryBatchEnrichedMetrics',
      userId,
      metricTypes,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}
