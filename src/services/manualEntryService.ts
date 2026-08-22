import { db } from '../db';
import { metricDefinitions, metricEntries } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { ValidationError, NotFoundError, DatabaseError } from '../errors/AppError';
import {
  MetricDefinitionRecord,
  createMetricDefinition,
  CreateMetricDefinitionParams,
} from './metricDefinitionService';
import { logger } from '../utils/logger';

export interface LogManualEntryParams {
  userId: string;
  definitionId?: string;
  metricType?: string;
  startTime: Date;
  endTime?: Date;
  valueNumeric?: number | null;
  valueText?: string | null;
  valueMin?: number | null;
  valueMax?: number | null;
  unit?: string | null;
  dimension?: string | null;
  definitionRecord?: MetricDefinitionRecord;
}

export interface UpdateManualEntryParams {
  id: string;
  userId: string;
  startTime?: Date;
  endTime?: Date;
  valueNumeric?: number | null;
  valueText?: string | null;
  valueMin?: number | null;
  valueMax?: number | null;
  unit?: string | null;
  dimension?: string | null;
}

export interface ManualEntryRecord {
  id: string;
  userId: string;
  provider: string;
  metricType: string;
  externalId: string | null;
  startTime: Date;
  endTime: Date;
  valueNumeric: number | null;
  valueText: string | null;
  valueMin: number | null;
  valueMax: number | null;
  unit: string | null;
  dimension: string;
  sourceStream: string | null;
  aggregation: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CombinedCreateAndLogParams {
  definition: CreateMetricDefinitionParams;
  entry: {
    startTime: Date;
    endTime?: Date;
    valueNumeric?: number | null;
    valueText?: string | null;
    valueMin?: number | null;
    valueMax?: number | null;
    unit?: string | null;
    dimension?: string | null;
  };
}

export async function logManualEntry(
  params: LogManualEntryParams,
  txClient?: typeof db
): Promise<ManualEntryRecord> {
  const client = txClient || db;
  const { userId, definitionId, metricType, startTime, endTime, dimension } = params;

  if (!startTime || isNaN(startTime.getTime())) {
    throw new ValidationError('Valid startTime is required', { operation: 'logManualEntry', userId });
  }

  const finalEndTime = endTime && !isNaN(endTime.getTime()) ? endTime : startTime;
  if (finalEndTime.getTime() < startTime.getTime()) {
    throw new ValidationError('endTime cannot be earlier than startTime', {
      operation: 'logManualEntry',
      userId,
      startTime,
      endTime: finalEndTime,
    });
  }

  // 1. Resolve definition scoped to userId
  let def: MetricDefinitionRecord;
  if (params.definitionRecord) {
    if (params.definitionRecord.userId !== userId) {
      throw new NotFoundError('Metric definition not found or unauthorized', {
        operation: 'logManualEntry',
        userId,
      });
    }
    def = params.definitionRecord;
  } else {
    if (!definitionId && !metricType) {
      throw new ValidationError('Either definitionId or metricType is required to log manual entry', {
        operation: 'logManualEntry',
        userId,
      });
    }

    const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
    if (!isLiveDb) {
      def = {
        id: definitionId || 'mock_def_id',
        userId,
        metricType: metricType || 'water-intake',
        displayName: 'Water Intake',
        valueType: 'numeric',
        unit: 'ml',
        categoryValues: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } else {
      const conditions = [eq(metricDefinitions.userId, userId)];
      if (definitionId) {
        conditions.push(eq(metricDefinitions.id, definitionId));
      } else if (metricType) {
        conditions.push(eq(metricDefinitions.metricType, metricType));
      }

      const [found] = await client
        .select()
        .from(metricDefinitions)
        .where(and(...conditions));

      if (!found) {
        throw new NotFoundError('Metric definition not found or unauthorized', {
          operation: 'logManualEntry',
          userId,
          definitionId,
          metricType,
        });
      }

      def = {
        id: found.id,
        userId: found.userId,
        metricType: found.metricType,
        displayName: found.displayName,
        valueType: found.valueType as 'numeric' | 'duration' | 'boolean' | 'category',
        unit: found.unit,
        categoryValues: found.categoryValues,
        archivedAt: found.archivedAt,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
      };
    }
  }

  // 2. Reject logging against archived definitions
  if (def.archivedAt !== null) {
    logger.warn('Rejected attempt to log entry against archived metric definition', {
      operation: 'logManualEntry',
      userId,
      metricType: def.metricType,
      archivedAt: def.archivedAt,
    });
    throw new ValidationError('Cannot log new entries against an archived metric definition', {
      operation: 'logManualEntry',
      userId,
      metricType: def.metricType,
      archivedAt: def.archivedAt,
    });
  }

  // 3. Value validation according to valueType
  let finalValueNumeric: number | null = null;
  let finalValueText: string | null = null;
  let finalUnit: string | null = null;

  if (def.valueType === 'numeric') {
    if (params.valueNumeric === undefined || params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
      throw new ValidationError(`Numeric value is required for numeric metric '${def.metricType}'`, {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        valueNumeric: params.valueNumeric,
      });
    }
    finalValueNumeric = Number(params.valueNumeric);
    finalValueText = null;
    finalUnit = params.unit || def.unit || '';
  } else if (def.valueType === 'duration') {
    if (
      params.valueNumeric === undefined ||
      params.valueNumeric === null ||
      isNaN(Number(params.valueNumeric)) ||
      Number(params.valueNumeric) < 0
    ) {
      throw new ValidationError(`Duration in seconds (non-negative number) is required for duration metric '${def.metricType}'`, {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        valueNumeric: params.valueNumeric,
      });
    }
    finalValueNumeric = Number(params.valueNumeric);
    finalValueText = null;
    finalUnit = params.unit || def.unit || 'seconds';
  } else if (def.valueType === 'boolean') {
    if (
      params.valueNumeric === undefined ||
      params.valueNumeric === null ||
      (params.valueNumeric !== 0 && params.valueNumeric !== 1)
    ) {
      throw new ValidationError(`Boolean value (0 or 1) is required for boolean metric '${def.metricType}'`, {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        valueNumeric: params.valueNumeric,
      });
    }
    finalValueNumeric = Number(params.valueNumeric);
    finalValueText = null;
    finalUnit = null;
  } else if (def.valueType === 'category') {
    if (!params.valueText || typeof params.valueText !== 'string' || params.valueText.trim().length === 0) {
      throw new ValidationError(`Category label is required for category metric '${def.metricType}'`, {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        valueText: params.valueText,
      });
    }
    const trimmedInput = params.valueText.trim();
    const validCategories = def.categoryValues || [];
    const matched = validCategories.find((c) => c.toLowerCase() === trimmedInput.toLowerCase());

    if (!matched) {
      throw new ValidationError(
        `Invalid category value '${trimmedInput}'. Allowed values: ${validCategories.join(', ')}`,
        {
          operation: 'logManualEntry',
          userId,
          metricType: def.metricType,
          submittedValue: trimmedInput,
          allowedValues: validCategories,
        }
      );
    }
    finalValueText = matched; // Preserve normalized casing from categoryValues definition
    finalValueNumeric = null;
    finalUnit = null;
  }

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
  if (!isLiveDb) {
    return {
      id: 'mock_manual_entry_' + Date.now(),
      userId,
      provider: 'manual',
      metricType: def.metricType,
      externalId: null,
      startTime,
      endTime: finalEndTime,
      valueNumeric: finalValueNumeric,
      valueText: finalValueText,
      valueMin: params.valueMin !== undefined && params.valueMin !== null ? Number(params.valueMin) : null,
      valueMax: params.valueMax !== undefined && params.valueMax !== null ? Number(params.valueMax) : null,
      unit: finalUnit,
      dimension: dimension || 'default',
      sourceStream: null,
      aggregation: 'raw',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
  }

  try {
    const [inserted] = await client
      .insert(metricEntries)
      .values({
        userId,
        provider: 'manual',
        metricType: def.metricType,
        externalId: null,
        startTime,
        endTime: finalEndTime,
        valueNumeric: finalValueNumeric,
        valueText: finalValueText,
        valueMin: params.valueMin !== undefined && params.valueMin !== null ? Number(params.valueMin) : null,
        valueMax: params.valueMax !== undefined && params.valueMax !== null ? Number(params.valueMax) : null,
        unit: finalUnit,
        dimension: dimension || 'default',
        sourceStream: null,
        aggregation: 'raw',
        rawPayload: null,
        updatedAt: new Date(),
      })
      .returning();

    logger.info('Manual metric entry logged successfully', {
      operation: 'logManualEntry',
      userId,
      entryId: inserted.id,
      metricType: def.metricType,
    });

    return {
      id: inserted.id,
      userId: inserted.userId,
      provider: inserted.provider,
      metricType: inserted.metricType,
      externalId: inserted.externalId,
      startTime: inserted.startTime,
      endTime: inserted.endTime,
      valueNumeric: inserted.valueNumeric,
      valueText: inserted.valueText,
      valueMin: inserted.valueMin,
      valueMax: inserted.valueMax,
      unit: inserted.unit,
      dimension: inserted.dimension,
      sourceStream: inserted.sourceStream,
      aggregation: inserted.aggregation,
      createdAt: inserted.createdAt,
      updatedAt: inserted.updatedAt,
      deletedAt: inserted.deletedAt,
    };
  } catch (err: unknown) {
    logger.error('Failed to log manual metric entry to database', {
      operation: 'logManualEntry',
      userId,
      metricType: def.metricType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new DatabaseError(
      'Failed to log manual metric entry',
      { operation: 'logManualEntry', userId, metricType: def.metricType, cause: err instanceof Error ? err.message : String(err) },
      err
    );
  }
}

export async function updateManualEntry(params: UpdateManualEntryParams): Promise<ManualEntryRecord> {
  const { id, userId } = params;

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
  if (!isLiveDb) {
    return {
      id,
      userId,
      provider: 'manual',
      metricType: 'water-intake',
      externalId: null,
      startTime: params.startTime || new Date(),
      endTime: params.endTime || params.startTime || new Date(),
      valueNumeric: params.valueNumeric !== undefined ? params.valueNumeric : 500,
      valueText: params.valueText ?? null,
      valueMin: params.valueMin ?? null,
      valueMax: params.valueMax ?? null,
      unit: params.unit || 'ml',
      dimension: params.dimension || 'default',
      sourceStream: null,
      aggregation: 'raw',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
  }

  // 1. Look up existing manual entry matching id, userId, provider='manual', and active
  const [existing] = await db
    .select()
    .from(metricEntries)
    .where(
      and(
        eq(metricEntries.id, id),
        eq(metricEntries.userId, userId),
        eq(metricEntries.provider, 'manual'),
        isNull(metricEntries.deletedAt)
      )
    );

  if (!existing) {
    throw new NotFoundError('Manual metric entry not found or unauthorized', {
      operation: 'updateManualEntry',
      id,
      userId,
    });
  }

  // 2. Look up metric definition (updating historical entries is allowed even if definition is archived)
  const [def] = await db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.userId, userId), eq(metricDefinitions.metricType, existing.metricType)));

  if (!def) {
    throw new NotFoundError(`Metric definition '${existing.metricType}' not found`, {
      operation: 'updateManualEntry',
      id,
      userId,
      metricType: existing.metricType,
    });
  }

  // 3. Validate updated values
  const startTime = params.startTime || existing.startTime;
  const endTime = params.endTime || (params.startTime ? params.startTime : existing.endTime);

  if (endTime.getTime() < startTime.getTime()) {
    throw new ValidationError('endTime cannot be earlier than startTime', {
      operation: 'updateManualEntry',
      id,
      userId,
      startTime,
      endTime,
    });
  }

  let finalValueNumeric = existing.valueNumeric;
  let finalValueText = existing.valueText;
  let finalUnit = existing.unit;

  if (def.valueType === 'numeric') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
        throw new ValidationError('Numeric value must be a valid number', { operation: 'updateManualEntry', id, userId });
      }
      finalValueNumeric = Number(params.valueNumeric);
    }
    if (params.unit !== undefined) {
      finalUnit = params.unit ? params.unit.trim() : def.unit;
    }
  } else if (def.valueType === 'duration') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric === null || isNaN(Number(params.valueNumeric)) || Number(params.valueNumeric) < 0) {
        throw new ValidationError('Duration value must be a non-negative number of seconds', {
          operation: 'updateManualEntry',
          id,
          userId,
        });
      }
      finalValueNumeric = Number(params.valueNumeric);
    }
  } else if (def.valueType === 'boolean') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric !== 0 && params.valueNumeric !== 1) {
        throw new ValidationError('Boolean value must be 0 or 1', { operation: 'updateManualEntry', id, userId });
      }
      finalValueNumeric = Number(params.valueNumeric);
    }
  } else if (def.valueType === 'category') {
    if (params.valueText !== undefined) {
      if (!params.valueText || typeof params.valueText !== 'string' || params.valueText.trim().length === 0) {
        throw new ValidationError('Category label cannot be empty', { operation: 'updateManualEntry', id, userId });
      }
      const trimmed = params.valueText.trim();
      const validCategories = def.categoryValues || [];
      const matched = validCategories.find((c) => c.toLowerCase() === trimmed.toLowerCase());
      if (!matched) {
        throw new ValidationError(
          `Invalid category value '${trimmed}'. Allowed values: ${validCategories.join(', ')}`,
          {
            operation: 'updateManualEntry',
            id,
            userId,
            submittedValue: trimmed,
            allowedValues: validCategories,
          }
        );
      }
      finalValueText = matched;
    }
  }

  try {
    const [updated] = await db
      .update(metricEntries)
      .set({
        startTime,
        endTime,
        valueNumeric: finalValueNumeric,
        valueText: finalValueText,
        valueMin: params.valueMin !== undefined ? (params.valueMin !== null ? Number(params.valueMin) : null) : existing.valueMin,
        valueMax: params.valueMax !== undefined ? (params.valueMax !== null ? Number(params.valueMax) : null) : existing.valueMax,
        unit: finalUnit,
        dimension: params.dimension ? params.dimension : existing.dimension,
        updatedAt: new Date(),
      })
      .where(and(eq(metricEntries.id, id), eq(metricEntries.userId, userId)))
      .returning();

    logger.info('Manual metric entry updated successfully', {
      operation: 'updateManualEntry',
      id,
      userId,
      metricType: updated.metricType,
    });

    return {
      id: updated.id,
      userId: updated.userId,
      provider: updated.provider,
      metricType: updated.metricType,
      externalId: updated.externalId,
      startTime: updated.startTime,
      endTime: updated.endTime,
      valueNumeric: updated.valueNumeric,
      valueText: updated.valueText,
      valueMin: updated.valueMin,
      valueMax: updated.valueMax,
      unit: updated.unit,
      dimension: updated.dimension,
      sourceStream: updated.sourceStream,
      aggregation: updated.aggregation,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      deletedAt: updated.deletedAt,
    };
  } catch (err: unknown) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    throw new DatabaseError('Failed to update manual metric entry', {
      operation: 'updateManualEntry',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function deleteManualEntry(id: string, userId: string): Promise<{ success: boolean; message: string }> {
  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
  if (!isLiveDb) {
    return { success: true, message: 'Manual metric entry deleted successfully' };
  }

  // Look up entry matching id, userId, provider='manual' and active
  const [existing] = await db
    .select({ id: metricEntries.id, metricType: metricEntries.metricType })
    .from(metricEntries)
    .where(
      and(
        eq(metricEntries.id, id),
        eq(metricEntries.userId, userId),
        eq(metricEntries.provider, 'manual'),
        isNull(metricEntries.deletedAt)
      )
    );

  if (!existing) {
    throw new NotFoundError('Manual metric entry not found or unauthorized', {
      operation: 'deleteManualEntry',
      id,
      userId,
    });
  }

  try {
    await db
      .update(metricEntries)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(metricEntries.id, id), eq(metricEntries.userId, userId)));

    logger.info('Manual metric entry soft-deleted successfully', {
      operation: 'deleteManualEntry',
      id,
      userId,
      metricType: existing.metricType,
    });

    return { success: true, message: 'Manual metric entry deleted successfully' };
  } catch (err: unknown) {
    throw new DatabaseError('Failed to delete manual metric entry', {
      operation: 'deleteManualEntry',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function createDefinitionAndLogFirstEntry(
  params: CombinedCreateAndLogParams,
  userId: string
): Promise<{ definition: MetricDefinitionRecord; entry: ManualEntryRecord }> {
  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    const def = await createMetricDefinition({ ...params.definition, userId });
    const entry = await logManualEntry({
      userId,
      definitionRecord: def,
      startTime: params.entry.startTime,
      endTime: params.entry.endTime,
      valueNumeric: params.entry.valueNumeric,
      valueText: params.entry.valueText,
      valueMin: params.entry.valueMin,
      valueMax: params.entry.valueMax,
      unit: params.entry.unit,
      dimension: params.entry.dimension,
    });
    return { definition: def, entry };
  }

  return await db.transaction(async (tx) => {
    try {
      // Step 1: Create definition
      const def = await createMetricDefinition({ ...params.definition, userId }, tx as unknown as typeof db);

      // Step 2: Log first entry directly passing created definition into tx
      const entry = await logManualEntry(
        {
          userId,
          definitionRecord: def,
          startTime: params.entry.startTime,
          endTime: params.entry.endTime,
          valueNumeric: params.entry.valueNumeric,
          valueText: params.entry.valueText,
          valueMin: params.entry.valueMin,
          valueMax: params.entry.valueMax,
          unit: params.entry.unit,
          dimension: params.entry.dimension,
        },
        tx as unknown as typeof db
      );

      logger.info('Combined create-definition-and-log-first-entry transaction committed', {
        operation: 'createDefinitionAndLogFirstEntry',
        userId,
        definitionId: def.id,
        entryId: entry.id,
        metricType: def.metricType,
      });

      return { definition: def, entry };
    } catch (err: unknown) {
      logger.error('Transaction rollback in createDefinitionAndLogFirstEntry', {
        operation: 'createDefinitionAndLogFirstEntry',
        userId,
        metricType: params.definition.metricType,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}
