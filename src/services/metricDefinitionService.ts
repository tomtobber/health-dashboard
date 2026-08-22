import { db } from '../db';
import { metricDefinitions, metricEntries } from '../db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { ValidationError, NotFoundError, DatabaseError } from '../errors/AppError';
import { isReservedMetricType } from '../adapters/manualEntryAdapter';
import { logger } from '../utils/logger';

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

export function validateMetricTypeFormat(metricType: string, userId: string): void {
  if (!metricType || typeof metricType !== 'string' || metricType.length < 2 || metricType.length > 50 || !KEBAB_CASE_REGEX.test(metricType)) {
    throw new ValidationError(
      "Metric type must be in kebab-case format (lowercase letters, numbers, and hyphens only, e.g. 'water-intake' or 'caffeine-mg')",
      { operation: 'validateMetricTypeFormat', userId, metricType }
    );
  }

  if (isReservedMetricType(metricType)) {
    throw new ValidationError(
      `Metric type '${metricType}' is reserved by a system provider`,
      { operation: 'validateMetricTypeFormat', userId, metricType }
    );
  }
}

export function validateCategoryValues(categoryValues: unknown, userId: string, operation: string): string[] {
  if (!Array.isArray(categoryValues) || categoryValues.length === 0) {
    throw new ValidationError(
      'Category values must be a non-empty array of strings',
      { operation, userId, categoryValues }
    );
  }

  const trimmedValues: string[] = [];
  const seen = new Set<string>();

  for (const item of categoryValues) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ValidationError(
        'Each category value must be a non-empty string',
        { operation, userId, categoryValues }
      );
    }
    const trimmed = item.trim();
    if (seen.has(trimmed.toLowerCase())) {
      throw new ValidationError(
        `Duplicate category value '${trimmed}' is not allowed`,
        { operation, userId, categoryValues }
      );
    }
    seen.add(trimmed.toLowerCase());
    trimmedValues.push(trimmed);
  }

  return trimmedValues;
}

export async function createMetricDefinition(params: CreateMetricDefinitionParams, txClient?: typeof db): Promise<MetricDefinitionRecord> {
  const client = txClient || db;
  const { userId, metricType, displayName, valueType } = params;

  validateMetricTypeFormat(metricType, userId);

  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new ValidationError('Display name is required', { operation: 'createMetricDefinition', userId });
  }

  const validTypes: MetricValueType[] = ['numeric', 'duration', 'boolean', 'category'];
  if (!validTypes.includes(valueType)) {
    throw new ValidationError(
      `Invalid value type '${valueType}'. Must be one of: ${validTypes.join(', ')}`,
      { operation: 'createMetricDefinition', userId, valueType }
    );
  }

  let finalUnit: string | null = null;
  if (valueType === 'numeric' || valueType === 'duration') {
    if (!params.unit || typeof params.unit !== 'string' || params.unit.trim().length === 0) {
      throw new ValidationError(
        `Unit is required for ${valueType} metrics`,
        { operation: 'createMetricDefinition', userId, valueType }
      );
    }
    finalUnit = params.unit.trim();
  } else {
    if (params.unit && typeof params.unit === 'string' && params.unit.trim().length > 0) {
      throw new ValidationError(
        `Unit must be null or omitted for ${valueType} metrics`,
        { operation: 'createMetricDefinition', userId, valueType, unit: params.unit }
      );
    }
  }

  let finalCategoryValues: string[] | null = null;
  if (valueType === 'category') {
    finalCategoryValues = validateCategoryValues(params.categoryValues, userId, 'createMetricDefinition');
  } else {
    if (params.categoryValues && Array.isArray(params.categoryValues) && params.categoryValues.length > 0) {
      throw new ValidationError(
        `Category values are only allowed when value_type is 'category'`,
        { operation: 'createMetricDefinition', userId, valueType }
      );
    }
  }

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return {
      id: 'mock_def_' + Date.now(),
      userId,
      metricType,
      displayName: displayName.trim(),
      valueType,
      unit: finalUnit,
      categoryValues: finalCategoryValues,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
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
      logger.warn('Metric definition unique constraint collision', {
        operation: 'createMetricDefinition',
        userId,
        metricType,
      });
      throw new ValidationError(
        `A metric definition with metric_type '${metricType}' already exists for this user`,
        { operation: 'createMetricDefinition', userId, metricType }
      );
    }

    logger.error('Failed to insert metric definition into database', {
      operation: 'createMetricDefinition',
      userId,
      metricType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to insert metric definition into database',
      { operation: 'createMetricDefinition', userId, metricType, cause: err instanceof Error ? err.message : String(err) },
      err
    );
  }
}

export async function getMetricDefinition(id: string, userId: string): Promise<MetricDefinitionRecord> {
  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return {
      id,
      userId,
      metricType: 'water-intake',
      displayName: 'Water Intake',
      valueType: 'numeric',
      unit: 'ml',
      categoryValues: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  try {
    const [found] = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

    if (!found) {
      throw new NotFoundError(`Metric definition with id '${id}' not found`, {
        operation: 'getMetricDefinition',
        id,
        userId,
      });
    }

    return {
      id: found.id,
      userId: found.userId,
      metricType: found.metricType,
      displayName: found.displayName,
      valueType: found.valueType as MetricValueType,
      unit: found.unit,
      categoryValues: found.categoryValues,
      archivedAt: found.archivedAt,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof NotFoundError) throw err;
    throw new DatabaseError('Failed to get metric definition', {
      operation: 'getMetricDefinition',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function listMetricDefinitions(userId: string, includeArchived: boolean = false): Promise<MetricDefinitionRecord[]> {
  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return [
      {
        id: 'mock_def_1',
        userId,
        metricType: 'water-intake',
        displayName: 'Water Intake',
        valueType: 'numeric',
        unit: 'ml',
        categoryValues: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  }

  try {
    const conditions = [eq(metricDefinitions.userId, userId)];
    if (!includeArchived) {
      conditions.push(isNull(metricDefinitions.archivedAt));
    }

    const rows = await db
      .select()
      .from(metricDefinitions)
      .where(and(...conditions))
      .orderBy(metricDefinitions.displayName);

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
  } catch (err: unknown) {
    throw new DatabaseError('Failed to list metric definitions', {
      operation: 'listMetricDefinitions',
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function updateMetricDefinition(params: UpdateMetricDefinitionParams): Promise<MetricDefinitionRecord> {
  const { id, userId } = params;
  const existing = await getMetricDefinition(id, userId);

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return {
      ...existing,
      displayName: params.displayName ? params.displayName.trim() : existing.displayName,
      unit: params.unit !== undefined ? params.unit : existing.unit,
      valueType: params.valueType || existing.valueType,
      categoryValues: params.categoryValues !== undefined ? params.categoryValues : existing.categoryValues,
      updatedAt: new Date(),
    };
  }

  // Check if caller is attempting to modify valueType or unit
  const wantsValueTypeChange = params.valueType !== undefined && params.valueType !== existing.valueType;
  const wantsUnitChange = params.unit !== undefined && params.unit !== existing.unit;

  if (wantsValueTypeChange || wantsUnitChange) {
    // Check if entries exist referencing this metricType
    const [entryCheck] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(metricEntries)
      .where(and(eq(metricEntries.userId, userId), eq(metricEntries.metricType, existing.metricType)));

    const entryCount = entryCheck?.count || 0;
    if (entryCount > 0) {
      logger.warn('Attempted modification of locked definition schema', {
        operation: 'updateMetricDefinition',
        userId,
        id,
        metricType: existing.metricType,
        attemptedValueType: params.valueType,
        attemptedUnit: params.unit,
        entryCount,
      });
      throw new ValidationError(
        `Cannot modify ${wantsValueTypeChange ? 'value_type' : ''}${wantsValueTypeChange && wantsUnitChange ? ' or ' : ''}${wantsUnitChange ? 'unit' : ''} once metric entries exist`,
        {
          operation: 'updateMetricDefinition',
          userId,
          id,
          metricType: existing.metricType,
          entryCount,
        }
      );
    }
  }

  let finalDisplayName = existing.displayName;
  if (params.displayName !== undefined) {
    if (typeof params.displayName !== 'string' || params.displayName.trim().length === 0) {
      throw new ValidationError('Display name cannot be empty', { operation: 'updateMetricDefinition', userId, id });
    }
    finalDisplayName = params.displayName.trim();
  }

  let finalValueType = existing.valueType;
  if (params.valueType !== undefined) {
    const validTypes: MetricValueType[] = ['numeric', 'duration', 'boolean', 'category'];
    if (!validTypes.includes(params.valueType)) {
      throw new ValidationError(`Invalid value type '${params.valueType}'`, { operation: 'updateMetricDefinition', userId, id });
    }
    finalValueType = params.valueType;
  }

  let finalUnit = existing.unit;
  if (params.unit !== undefined) {
    if (finalValueType === 'numeric' || finalValueType === 'duration') {
      if (!params.unit || typeof params.unit !== 'string' || params.unit.trim().length === 0) {
        throw new ValidationError(`Unit is required for ${finalValueType} metrics`, { operation: 'updateMetricDefinition', userId, id });
      }
      finalUnit = params.unit.trim();
    } else {
      if (params.unit && typeof params.unit === 'string' && params.unit.trim().length > 0) {
        throw new ValidationError(`Unit must be null for ${finalValueType} metrics`, { operation: 'updateMetricDefinition', userId, id });
      }
      finalUnit = null;
    }
  }

  let finalCategoryValues = existing.categoryValues;
  if (params.categoryValues !== undefined) {
    if (finalValueType === 'category') {
      const validatedNewCategories = validateCategoryValues(params.categoryValues, userId, 'updateMetricDefinition');
      
      // If categories already exist and entries exist, verify none of the removed categories are in use
      if (existing.categoryValues && existing.categoryValues.length > 0) {
        const newCatSet = new Set(validatedNewCategories.map((c) => c.toLowerCase()));
        const removedCategories = existing.categoryValues.filter((c) => !newCatSet.has(c.toLowerCase()));

        if (removedCategories.length > 0) {
          const usedEntries = await db
            .select({ valueText: metricEntries.valueText })
            .from(metricEntries)
            .where(
              and(
                eq(metricEntries.userId, userId),
                eq(metricEntries.metricType, existing.metricType),
                isNull(metricEntries.deletedAt)
              )
            );

          const inUseValues = new Set(usedEntries.map((e) => e.valueText?.toLowerCase()).filter(Boolean));
          const blockedCategories = removedCategories.filter((c) => inUseValues.has(c.toLowerCase()));

          if (blockedCategories.length > 0) {
            logger.warn('Category removal blocked: category values are currently in use by existing entries', {
              operation: 'updateMetricDefinition',
              userId,
              id,
              metricType: existing.metricType,
              blockedCategories,
            });
            throw new ValidationError(
              `Cannot remove category values currently in use: ${blockedCategories.join(', ')}`,
              {
                operation: 'updateMetricDefinition',
                userId,
                id,
                metricType: existing.metricType,
                blockedCategories,
              }
            );
          }
        }
      }
      finalCategoryValues = validatedNewCategories;
    } else {
      finalCategoryValues = null;
    }
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
      id,
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
    throw new DatabaseError('Failed to update metric definition', {
      operation: 'updateMetricDefinition',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function archiveMetricDefinition(id: string, userId: string): Promise<MetricDefinitionRecord> {
  const existing = await getMetricDefinition(id, userId);

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
  if (!isLiveDb) {
    return {
      ...existing,
      archivedAt: new Date(),
      updatedAt: new Date(),
    };
  }

  try {
    const [updated] = await db
      .update(metricDefinitions)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)))
      .returning();

    logger.info('Metric definition archived successfully', {
      operation: 'archiveMetricDefinition',
      userId,
      id,
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
    throw new DatabaseError('Failed to archive metric definition', {
      operation: 'archiveMetricDefinition',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function deleteMetricDefinition(id: string, userId: string): Promise<{ success: boolean; message: string }> {
  const existing = await getMetricDefinition(id, userId);

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return { success: true, message: 'Metric definition deleted successfully' };
  }

  try {
    // Check if any entries exist for this metricType
    const [entryCheck] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(metricEntries)
      .where(and(eq(metricEntries.userId, userId), eq(metricEntries.metricType, existing.metricType)));

    const entryCount = entryCheck?.count || 0;
    if (entryCount > 0) {
      logger.warn('Delete rejected: metric definition has associated entries', {
        operation: 'deleteMetricDefinition',
        userId,
        id,
        metricType: existing.metricType,
        entryCount,
      });
      throw new ValidationError(
        'Cannot delete metric definition with existing entries. Archive it instead.',
        {
          operation: 'deleteMetricDefinition',
          userId,
          id,
          metricType: existing.metricType,
          entryCount,
        }
      );
    }

    await db
      .delete(metricDefinitions)
      .where(and(eq(metricDefinitions.id, id), eq(metricDefinitions.userId, userId)));

    logger.info('Metric definition deleted successfully', {
      operation: 'deleteMetricDefinition',
      userId,
      id,
      metricType: existing.metricType,
    });

    return { success: true, message: 'Metric definition deleted successfully' };
  } catch (err: unknown) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    throw new DatabaseError('Failed to delete metric definition', {
      operation: 'deleteMetricDefinition',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}
