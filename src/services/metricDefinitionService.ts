import { db } from '../db';
import { metricDefinitions, metricEntries } from '../db/schema';
import { and, eq, count, isNull } from 'drizzle-orm';
import { ValidationError, NotFoundError, DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { isReservedMetricType } from '../adapters/manualEntryAdapter';

export type MetricValueType = 'numeric' | 'duration' | 'boolean' | 'category';

export interface CreateMetricDefinitionParams {
  userId: string;
  metricType: string;
  displayName: string;
  valueType: MetricValueType;
  unit?: string | null;
  categoryValues?: string[] | null;
}

export interface UpdateMetricDefinitionParams {
  id: string;
  userId: string;
  displayName?: string;
  valueType?: MetricValueType;
  unit?: string | null;
  categoryValues?: string[] | null;
}

export interface MetricDefinitionRecord {
  id: string;
  userId: string;
  metricType: string;
  displayName: string;
  valueType: MetricValueType;
  unit: string | null;
  categoryValues: string[] | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const KEBAB_CASE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;


export function validateMetricTypeFormat(metricType: string, _userId?: string): void {
  validateMetricType(metricType);
}

export function validateCategoryValues(
  categoryValues: string[] | null | undefined,
  _userId?: string,
  _metricType?: string
): string[] {
  if (!categoryValues || !Array.isArray(categoryValues) || categoryValues.length === 0) {
    throw new ValidationError('category_values must be a non-empty array of strings', {
      operation: 'validateCategoryValues',
    });
  }

  const cleaned = categoryValues
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());

  if (cleaned.length === 0) {
    throw new ValidationError('category_values cannot be empty after trimming whitespace', {
      operation: 'validateCategoryValues',
    });
  }

  const lowerSet = new Set<string>();
  for (const item of cleaned) {
    const lower = item.toLowerCase();
    if (lowerSet.has(lower)) {
      throw new ValidationError(`Duplicate category value found: '${item}'`, {
        operation: 'validateCategoryValues',
        duplicate: item,
      });
    }
    lowerSet.add(lower);
  }

  return cleaned;
}

export function validateMetricType(metricType: string): void {
  if (!metricType || typeof metricType !== 'string') {
    throw new ValidationError('metric_type is required and must be a non-empty string', {
      operation: 'validateMetricType',
      metricType,
    });
  }

  const trimmed = metricType.trim();

  if (trimmed.length < 2 || trimmed.length > 50) {
    throw new ValidationError(
      `metric_type must be between 2 and 50 characters in length. Received '${trimmed}' (${trimmed.length} chars)`,
      { operation: 'validateMetricType', metricType: trimmed, length: trimmed.length }
    );
  }

  if (!KEBAB_CASE_REGEX.test(trimmed)) {
    throw new ValidationError(
      `metric_type must follow strict kebab-case (lowercase alphanumeric characters separated by single hyphens, e.g. 'coffee-cups', 'alcohol-units'). Received '${trimmed}'`,
      { operation: 'validateMetricType', metricType: trimmed }
    );
  }

  if (isReservedMetricType(trimmed)) {
    throw new ValidationError(
      `metric_type '${trimmed}' is a reserved provider keyword and cannot be used as a custom metric name.`,
      { operation: 'validateMetricType', metricType: trimmed }
    );
  }
}

export async function createMetricDefinition(
  params: CreateMetricDefinitionParams,
  txClient?: typeof db
): Promise<MetricDefinitionRecord> {
  const client = txClient || db;
  const { userId, metricType, displayName, valueType } = params;

  validateMetricType(metricType);

  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new ValidationError('display_name is required and must not be empty', {
      operation: 'createMetricDefinition',
      userId,
      displayName,
    });
  }

  const validTypes: MetricValueType[] = ['numeric', 'duration', 'boolean', 'category'];
  if (!validTypes.includes(valueType)) {
    throw new ValidationError(
      `Invalid value_type '${valueType}'. Allowed types: ${validTypes.join(', ')}`,
      { operation: 'createMetricDefinition', userId, valueType }
    );
  }

  let finalUnit: string | null = null;
  let finalCategoryValues: string[] | null = null;

  if (valueType === 'numeric') {
    if (!params.unit || typeof params.unit !== 'string' || params.unit.trim().length === 0) {
      throw new ValidationError(`unit is required for numeric metric '${metricType}'`, {
        operation: 'createMetricDefinition',
        userId,
        metricType,
        valueType,
      });
    }
    finalUnit = params.unit.trim();
  } else if (valueType === 'duration') {
    finalUnit = params.unit ? params.unit.trim() : 'seconds';
  } else if (valueType === 'boolean') {
    if (params.unit !== undefined && params.unit !== null && String(params.unit).trim().length > 0) {
      throw new ValidationError(`unit is not allowed when value_type is 'boolean'`, {
        operation: 'createMetricDefinition',
        userId,
        valueType,
      });
    }
    finalUnit = null;
    if (params.categoryValues && params.categoryValues.length > 0) {
      throw new ValidationError(`category_values are not allowed when value_type is 'boolean'`, {
        operation: 'createMetricDefinition',
        userId,
        valueType,
      });
    }
  } else if (valueType === 'category') {
    if (params.unit !== undefined && params.unit !== null && String(params.unit).trim().length > 0) {
      throw new ValidationError(`unit is not allowed when value_type is 'category'`, {
        operation: 'createMetricDefinition',
        userId,
        valueType,
      });
    }
    finalUnit = null;
    if (!params.categoryValues || !Array.isArray(params.categoryValues) || params.categoryValues.length === 0) {
      throw new ValidationError(
        `category_values must be a non-empty array of strings for category metric '${metricType}'`,
        { operation: 'createMetricDefinition', userId, metricType, valueType }
      );
    }

    const cleaned = params.categoryValues
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());

    const deduplicated = Array.from(new Set(cleaned));

    if (deduplicated.length === 0) {
      throw new ValidationError(
        `category_values cannot be empty after trimming whitespace`,
        { operation: 'createMetricDefinition', userId, metricType }
      );
    }

    finalCategoryValues = deduplicated;
  }

  try {
    const [created] = await client
      .insert(metricDefinitions)
      .values({
        userId,
        metricType,
        displayName: displayName.trim(),
        valueType,
        unit: finalUnit,
        categoryValues: finalCategoryValues,
      })
      .returning();

    logger.info('Metric definition created successfully', {
      operation: 'createMetricDefinition',
      userId,
      metricType,
      definitionId: created.id,
    });

    return {
      id: created.id,
      userId: created.userId,
      metricType: created.metricType,
      displayName: created.displayName,
      valueType: created.valueType as MetricValueType,
      unit: created.unit,
      categoryValues: created.categoryValues,
      archivedAt: created.archivedAt,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  } catch (err: unknown) {
    const rawErr = err as { code?: string; cause?: { code?: string } };
    const pgCode = rawErr?.code || rawErr?.cause?.code;

    if (pgCode === '23505') {
      logger.warn('Unique constraint violation on metric_definitions (23505)', {
        operation: 'createMetricDefinition',
        userId,
        metricType,
      });
      throw new ValidationError(
        `Metric type '${metricType}' already exists for this user.`,
        { operation: 'createMetricDefinition', userId, metricType, code: '23505' }
      );
    }

    logger.error('Failed to create metric definition', {
      operation: 'createMetricDefinition',
      userId,
      metricType,
      cause: err instanceof Error ? err.message : String(err),
    });

    throw new DatabaseError(
      'Failed to create metric definition',
      {
        operation: 'createMetricDefinition',
        userId,
        metricType,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function updateMetricDefinition(
  params: UpdateMetricDefinitionParams
): Promise<MetricDefinitionRecord> {
  const { id, userId, displayName, valueType, unit, categoryValues } = params;

  const [existing] = await db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

  if (!existing) {
    throw new NotFoundError('Metric definition not found or unauthorized', {
      operation: 'updateMetricDefinition',
      id,
      userId,
    });
  }

  const [entryCountRow] = await db
    .select({ total: count() })
    .from(metricEntries)
    .where(
      and(
        eq(metricEntries.userId, userId),
        eq(metricEntries.metricType, existing.metricType),
        isNull(metricEntries.deletedAt)
      )
    );

  const hasEntries = (entryCountRow?.total || 0) > 0;

  if (hasEntries) {
    if (valueType !== undefined && valueType !== existing.valueType) {
      logger.warn('Attempted to modify locked value_type on metric definition with existing entries', {
        operation: 'updateMetricDefinition',
        userId,
        definitionId: id,
        metricType: existing.metricType,
        currentValueType: existing.valueType,
        attemptedValueType: valueType,
        entryCount: entryCountRow?.total,
      });
      throw new ValidationError(
        `Cannot change value_type on metric '${existing.metricType}' because ${entryCountRow?.total} metric entries already exist. Only display_name can be changed after entries exist.`,
        {
          operation: 'updateMetricDefinition',
          userId,
          definitionId: id,
          metricType: existing.metricType,
        }
      );
    }

    if (unit !== undefined && unit !== existing.unit) {
      logger.warn('Attempted to modify locked unit on metric definition with existing entries', {
        operation: 'updateMetricDefinition',
        userId,
        definitionId: id,
        metricType: existing.metricType,
        currentUnit: existing.unit,
        attemptedUnit: unit,
        entryCount: entryCountRow?.total,
      });
      throw new ValidationError(
        `Cannot change unit on metric '${existing.metricType}' because ${entryCountRow?.total} metric entries already exist. Only display_name can be changed after entries exist.`,
        {
          operation: 'updateMetricDefinition',
          userId,
          definitionId: id,
          metricType: existing.metricType,
        }
      );
    }

    if (categoryValues !== undefined && existing.valueType === 'category') {
      const activeEntries = await db
        .select({ valueText: metricEntries.valueText })
        .from(metricEntries)
        .where(
          and(
            eq(metricEntries.userId, userId),
            eq(metricEntries.metricType, existing.metricType),
            isNull(metricEntries.deletedAt)
          )
        );

      const inUseCategories = new Set(
        activeEntries.map((e) => e.valueText).filter((v): v is string => Boolean(v))
      );

      const newCategoryList = (categoryValues || []).map((c) => c.trim().toLowerCase());
      for (const inUse of Array.from(inUseCategories)) {
        if (!newCategoryList.includes(inUse.toLowerCase())) {
          logger.warn('Attempted to remove in-use category from category definition', {
            operation: 'updateMetricDefinition',
            userId,
            definitionId: id,
            metricType: existing.metricType,
            removedCategory: inUse,
          });
          throw new ValidationError(
            `Cannot remove category '${inUse}' because existing entries currently use this label.`,
            {
              operation: 'updateMetricDefinition',
              userId,
              definitionId: id,
              metricType: existing.metricType,
              inUseCategory: inUse,
            }
          );
        }
      }
    }
  }

  const finalDisplayName = displayName !== undefined ? displayName.trim() : existing.displayName;
  if (!finalDisplayName) {
    throw new ValidationError('display_name cannot be empty', {
      operation: 'updateMetricDefinition',
      userId,
      id,
    });
  }

  let finalValueType = existing.valueType as MetricValueType;
  let finalUnit = existing.unit;
  let finalCategoryValues = existing.categoryValues;

  if (!hasEntries) {
    if (valueType !== undefined) {
      finalValueType = valueType;
    }
    if (unit !== undefined) {
      finalUnit = unit;
    }
    if (categoryValues !== undefined) {
      finalCategoryValues = categoryValues;
    }
  } else if (categoryValues !== undefined && existing.valueType === 'category') {
    const cleaned = (categoryValues || [])
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    finalCategoryValues = Array.from(new Set(cleaned));
  }

  try {
    const [updated] = await db
      .update(metricDefinitions)
      .set({
        displayName: finalDisplayName,
        valueType: finalValueType,
        unit: finalUnit,
        categoryValues: finalCategoryValues,
        updatedAt: new Date(),
      })
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)))
      .returning();

    logger.info('Metric definition updated successfully', {
      operation: 'updateMetricDefinition',
      userId,
      definitionId: id,
      metricType: updated.metricType,
    });

    return {
      id: updated.id,
      userId: updated.userId,
      metricType: updated.metricType,
      displayName: updated.displayName,
      valueType: updated.valueType as MetricValueType,
      unit: updated.unit,
      categoryValues: updated.categoryValues,
      archivedAt: updated.archivedAt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to update metric definition',
      {
        operation: 'updateMetricDefinition',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function archiveMetricDefinition(
  id: string,
  userId: string
): Promise<MetricDefinitionRecord> {
  const [existing] = await db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

  if (!existing) {
    throw new NotFoundError('Metric definition not found or unauthorized', {
      operation: 'archiveMetricDefinition',
      id,
      userId,
    });
  }

  if (existing.archivedAt) {
    return {
      id: existing.id,
      userId: existing.userId,
      metricType: existing.metricType,
      displayName: existing.displayName,
      valueType: existing.valueType as MetricValueType,
      unit: existing.unit,
      categoryValues: existing.categoryValues,
      archivedAt: existing.archivedAt,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }

  try {
    const [archived] = await db
      .update(metricDefinitions)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)))
      .returning();

    logger.info('Metric definition soft-archived successfully', {
      operation: 'archiveMetricDefinition',
      userId,
      id,
      metricType: archived.metricType,
    });

    return {
      id: archived.id,
      userId: archived.userId,
      metricType: archived.metricType,
      displayName: archived.displayName,
      valueType: archived.valueType as MetricValueType,
      unit: archived.unit,
      categoryValues: archived.categoryValues,
      archivedAt: archived.archivedAt,
      createdAt: archived.createdAt,
      updatedAt: archived.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to archive metric definition',
      {
        operation: 'archiveMetricDefinition',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function deleteMetricDefinition(
  id: string,
  userId: string
): Promise<{ success: boolean; message: string }> {
  const [existing] = await db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

  if (!existing) {
    throw new NotFoundError('Metric definition not found or unauthorized', {
      operation: 'deleteMetricDefinition',
      id,
      userId,
    });
  }

  const [entryCountRow] = await db
    .select({ total: count() })
    .from(metricEntries)
    .where(
      and(
        eq(metricEntries.userId, userId),
        eq(metricEntries.metricType, existing.metricType),
        isNull(metricEntries.deletedAt)
      )
    );

  const entryCount = entryCountRow?.total || 0;

  if (entryCount > 0) {
    logger.warn('Attempted to hard-delete metric definition with existing entries', {
      operation: 'deleteMetricDefinition',
      userId,
      id,
      metricType: existing.metricType,
      entryCount,
    });
    throw new ValidationError(
      `Cannot delete metric definition '${existing.metricType}' because ${entryCount} associated metric entries exist. Please archive it instead.`,
      {
        operation: 'deleteMetricDefinition',
        userId,
        id,
        metricType: existing.metricType,
        entryCount,
      }
    );
  }

  try {
    await db
      .delete(metricDefinitions)
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

    logger.info('Metric definition deleted successfully', {
      operation: 'deleteMetricDefinition',
      userId,
      id,
      metricType: existing.metricType,
    });

    return {
      success: true,
      message: `Metric definition '${existing.metricType}' successfully deleted`,
    };
  } catch (err: unknown) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to delete metric definition',
      {
        operation: 'deleteMetricDefinition',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function getMetricDefinition(
  id: string,
  userId: string
): Promise<MetricDefinitionRecord> {
  const [def] = await db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

  if (!def) {
    throw new NotFoundError('Metric definition not found or unauthorized', {
      operation: 'getMetricDefinition',
      id,
      userId,
    });
  }

  return {
    id: def.id,
    userId: def.userId,
    metricType: def.metricType,
    displayName: def.displayName,
    valueType: def.valueType as MetricValueType,
    unit: def.unit,
    categoryValues: def.categoryValues,
    archivedAt: def.archivedAt,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

export async function listMetricDefinitions(
  userId: string,
  includeArchived = false
): Promise<MetricDefinitionRecord[]> {
  const conditions = [eq(metricDefinitions.userId, userId)];
  if (!includeArchived) {
    conditions.push(isNull(metricDefinitions.archivedAt));
  }

  const rows = await db
    .select()
    .from(metricDefinitions)
    .where(and(...conditions));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    metricType: r.metricType,
    displayName: r.displayName,
    valueType: r.valueType as MetricValueType,
    unit: r.unit,
    categoryValues: r.categoryValues,
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
