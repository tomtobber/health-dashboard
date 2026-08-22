import { NormalizedMetricEntry, getCanonicalProviderMetricMetadata } from '../adapters/baseAdapter';
import { db } from '../db';
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

export async function queryMetricEntriesFromDb(filter: MetricQueryFilter): Promise<NormalizedMetricEntry[]> {
  try {
    const whereConditions = [
      eq(metricEntries.userId, filter.userId),
      eq(metricEntries.metricType, filter.metricType),
      gte(metricEntries.startTime, filter.startTime),
      lte(metricEntries.endTime, filter.endTime),
      isNull(metricEntries.deletedAt),
    ];

    if (filter.dimension) {
      whereConditions.push(eq(metricEntries.dimension, filter.dimension));
    }

    if (filter.aggregation) {
      whereConditions.push(eq(metricEntries.aggregation, filter.aggregation));
    }

    const rows = await db
      .select()
      .from(metricEntries)
      .where(and(...whereConditions));

    const mapped: MetricEntryWithDelete[] = rows.map((row) => ({
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
      rawPayload: row.rawPayload as Record<string, unknown> | undefined,
      deletedAt: row.deletedAt,
    }));

    return filterReconciledOverRaw(mapped);
  } catch (err: unknown) {
    throw new DatabaseError('Failed to query metric entries from database', {
      operation: 'queryMetricEntriesFromDb',
      filter,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

/**
 * Enriched single-metric query resolving display_name, value_type, unit, and category_values
 * without filtering out archived definitions (allowing historical chart rendering).
 */
export async function queryEnrichedMetricEntries(filter: MetricQueryFilter): Promise<EnrichedMetricQueryResult> {
  try {
    // 1. Look up metric definition WITHOUT filtering out archived_at
    const [def] = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.userId, filter.userId), eq(metricDefinitions.metricType, filter.metricType)));

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
      const canonical = getCanonicalProviderMetricMetadata(filter.metricType);
      displayName = canonical.displayName;
      valueType = canonical.valueType;
      unit = canonical.unit;
      categoryValues = canonical.categoryValues || null;
      isCustom = false;
      isArchived = false;
    }

    // 2. Query entries
    const entries = await queryMetricEntriesFromDb(filter);

    return {
      metricType: filter.metricType,
      displayName,
      valueType,
      unit,
      categoryValues,
      isCustom,
      isArchived,
      entries,
    };
  } catch (err: unknown) {
    throw new DatabaseError('Failed to query enriched metric entries', {
      operation: 'queryEnrichedMetricEntries',
      filter,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

/**
 * Batch enriched metric query eliminating N+1 lookups for multi-metric dashboard views.
 * Resolves definitions and entries in 2 consolidated SQL queries.
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
    // 1. Batch definition lookup in 1 query (no archived_at filter!)
    const definitions = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.userId, userId), inArray(metricDefinitions.metricType, metricTypes)));

    const defMap = new Map<string, typeof definitions[0]>();
    for (const d of definitions) {
      defMap.set(d.metricType, d);
    }

    // 2. Batch entries query in 1 query
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

    const rows = await db
      .select()
      .from(metricEntries)
      .where(and(...whereConditions));

    // 3. Group rows by metric_type
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
          rawPayload: row.rawPayload as Record<string, unknown> | undefined,
          deletedAt: row.deletedAt,
        });
      }
    }

    // 4. Assemble enriched results for all requested metricTypes
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

      const metricRows = rowsByMetric.get(mt) || [];
      const filteredEntries = filterReconciledOverRaw(metricRows);

      results.push({
        metricType: mt,
        displayName,
        valueType,
        unit,
        categoryValues,
        isCustom,
        isArchived,
        entries: filteredEntries,
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
