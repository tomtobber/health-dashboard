import { db } from '../db';
import { metricDefinitions, metricEntries } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { ValidationError, NotFoundError, DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';
import {
  MetricValueType,
  CreateMetricDefinitionParams,
  MetricDefinitionRecord,
  createMetricDefinition,
} from './metricDefinitionService';

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
      valueType: found.valueType as MetricValueType,
      unit: found.unit,
      categoryValues: found.categoryValues,
      archivedAt: found.archivedAt,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
    };
  }

  // 2. Reject logging new entries against archived definitions
  if (def.archivedAt !== null && def.archivedAt !== undefined) {
    throw new ValidationError(
      `Cannot log new entries for archived metric definition '${def.metricType}'. Create a new definition instead.`,
      {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        definitionId: def.id,
        archivedAt: def.archivedAt,
      }
    );
  }

  // 3. Validate and map value according to value_type
  let finalValueNumeric: number | null = null;
  let finalValueText: string | null = null;
  let finalUnit: string | null = null;

  if (def.valueType === 'numeric') {
    if (params.valueNumeric === undefined || params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
      throw new ValidationError(
        `Numeric value is required for numeric metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
      );
    }
    finalValueNumeric = Number(params.valueNumeric);
    finalValueText = null;
    finalUnit = params.unit ? params.unit.trim() : def.unit;
  } else if (def.valueType === 'duration') {
    if (params.valueNumeric === undefined || params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
      throw new ValidationError(
        `Duration value in seconds is required for duration metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
      );
    }
    const sec = Number(params.valueNumeric);
    if (sec < 0) {
      throw new ValidationError(
        `Duration cannot be negative for metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, seconds: sec }
      );
    }
    finalValueNumeric = sec;
    finalValueText = null;
    finalUnit = def.unit || 'seconds';
  } else if (def.valueType === 'boolean') {
    if (params.valueNumeric === undefined || params.valueNumeric === null) {
      throw new ValidationError(
        `Boolean value (0 or 1) is required for boolean metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
      );
    }
    const val = Number(params.valueNumeric);
    if (val !== 0 && val !== 1) {
      throw new ValidationError(
        `Boolean value must be 0 or 1 for boolean metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, value: val }
      );
    }
    finalValueNumeric = val;
    finalValueText = null;
    finalUnit = null;
  } else if (def.valueType === 'category') {
    if (!params.valueText || typeof params.valueText !== 'string' || !params.valueText.trim()) {
      throw new ValidationError(
        `Category label is required for category metric '${def.metricType}'`,
        { operation: 'logManualEntry', userId, metricType: def.metricType, valueText: params.valueText }
      );
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
    finalValueText = matched;
    finalValueNumeric = null;
    finalUnit = null;
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
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to insert manual metric entry',
      {
        operation: 'logManualEntry',
        userId,
        metricType: def.metricType,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function updateManualEntry(params: UpdateManualEntryParams): Promise<ManualEntryRecord> {
  const { id, userId } = params;

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
    throw new NotFoundError('Associated metric definition not found or unauthorized', {
      operation: 'updateManualEntry',
      id,
      userId,
      metricType: existing.metricType,
    });
  }

  // 3. Calculate time bounds
  const finalStartTime = params.startTime || existing.startTime;
  const finalEndTime = params.endTime !== undefined ? params.endTime : (params.startTime ? params.startTime : existing.endTime);

  if (finalEndTime.getTime() < finalStartTime.getTime()) {
    throw new ValidationError('endTime cannot be earlier than startTime', {
      operation: 'updateManualEntry',
      id,
      userId,
      startTime: finalStartTime,
      endTime: finalEndTime,
    });
  }

  // 4. Validate and map updated value according to value_type
  let finalValueNumeric = existing.valueNumeric;
  let finalValueText = existing.valueText;
  let finalUnit = existing.unit;

  if (def.valueType === 'numeric') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
        throw new ValidationError(
          `Numeric value is required for numeric metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
        );
      }
      finalValueNumeric = Number(params.valueNumeric);
    }
    finalValueText = null;
    if (params.unit !== undefined) {
      finalUnit = params.unit ? params.unit.trim() : def.unit;
    }
  } else if (def.valueType === 'duration') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric === null || isNaN(Number(params.valueNumeric))) {
        throw new ValidationError(
          `Duration value in seconds is required for duration metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
        );
      }
      const sec = Number(params.valueNumeric);
      if (sec < 0) {
        throw new ValidationError(
          `Duration cannot be negative for metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, seconds: sec }
        );
      }
      finalValueNumeric = sec;
    }
    finalValueText = null;
    finalUnit = def.unit || 'seconds';
  } else if (def.valueType === 'boolean') {
    if (params.valueNumeric !== undefined) {
      if (params.valueNumeric === null) {
        throw new ValidationError(
          `Boolean value (0 or 1) is required for boolean metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, value: params.valueNumeric }
        );
      }
      const val = Number(params.valueNumeric);
      if (val !== 0 && val !== 1) {
        throw new ValidationError(
          `Boolean value must be 0 or 1 for boolean metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, value: val }
        );
      }
      finalValueNumeric = val;
    }
    finalValueText = null;
    finalUnit = null;
  } else if (def.valueType === 'category') {
    if (params.valueText !== undefined) {
      if (!params.valueText || typeof params.valueText !== 'string' || !params.valueText.trim()) {
        throw new ValidationError(
          `Category label is required for category metric '${def.metricType}'`,
          { operation: 'updateManualEntry', userId, metricType: def.metricType, valueText: params.valueText }
        );
      }
      const trimmedInput = params.valueText.trim();
      const validCategories = def.categoryValues || [];
      const matched = validCategories.find((c) => c.toLowerCase() === trimmedInput.toLowerCase());

      if (!matched) {
        throw new ValidationError(
          `Invalid category value '${trimmedInput}'. Allowed values: ${validCategories.join(', ')}`,
          {
            operation: 'updateManualEntry',
            userId,
            metricType: def.metricType,
            submittedValue: trimmedInput,
            allowedValues: validCategories,
          }
        );
      }
      finalValueText = matched;
    }
    finalValueNumeric = null;
    finalUnit = null;
  }

  const finalValueMin = params.valueMin !== undefined ? (params.valueMin !== null ? Number(params.valueMin) : null) : existing.valueMin;
  const finalValueMax = params.valueMax !== undefined ? (params.valueMax !== null ? Number(params.valueMax) : null) : existing.valueMax;
  const finalDimension = params.dimension !== undefined ? (params.dimension || 'default') : existing.dimension;

  try {
    const [updated] = await db
      .update(metricEntries)
      .set({
        startTime: finalStartTime,
        endTime: finalEndTime,
        valueNumeric: finalValueNumeric,
        valueText: finalValueText,
        valueMin: finalValueMin,
        valueMax: finalValueMax,
        unit: finalUnit,
        dimension: finalDimension,
        updatedAt: new Date(),
      })
      .where(and(eq(metricEntries.id, id), eq(metricEntries.userId, userId)))
      .returning();

    logger.info('Manual metric entry updated successfully', {
      operation: 'updateManualEntry',
      userId,
      id,
      metricType: def.metricType,
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
    throw new DatabaseError(
      'Failed to update manual metric entry',
      {
        operation: 'updateManualEntry',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function deleteManualEntry(
  id: string,
  userId: string
): Promise<{ success: boolean; message: string }> {
  // 1. Look up existing manual entry
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
      operation: 'deleteManualEntry',
      id,
      userId,
    });
  }

  try {
    await db
      .update(metricEntries)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(metricEntries.id, id), eq(metricEntries.userId, userId)));

    logger.info('Manual metric entry soft-deleted successfully', {
      operation: 'deleteManualEntry',
      userId,
      id,
      metricType: existing.metricType,
    });

    return {
      success: true,
      message: `Manual metric entry '${id}' soft-deleted successfully`,
    };
  } catch (err: unknown) {
    if (err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to soft-delete manual metric entry',
      {
        operation: 'deleteManualEntry',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function createDefinitionAndLogFirstEntry(
  params: CombinedCreateAndLogParams,
  userId: string
): Promise<{ definition: MetricDefinitionRecord; entry: ManualEntryRecord }> {
  const { definition: defParams, entry: entryParams } = params;

  if (defParams.userId !== userId) {
    throw new ValidationError('Definition userId must match authenticated user', {
      operation: 'createDefinitionAndLogFirstEntry',
      userId,
      defUserId: defParams.userId,
    });
  }

  try {
    return await db.transaction(async (tx) => {
      const txClient = tx as unknown as typeof db;

      const createdDef = await createMetricDefinition(defParams, txClient);

      const loggedEntry = await logManualEntry(
        {
          userId,
          definitionId: createdDef.id,
          startTime: entryParams.startTime,
          endTime: entryParams.endTime,
          valueNumeric: entryParams.valueNumeric,
          valueText: entryParams.valueText,
          valueMin: entryParams.valueMin,
          valueMax: entryParams.valueMax,
          unit: entryParams.unit,
          dimension: entryParams.dimension,
          definitionRecord: createdDef,
        },
        txClient
      );

      logger.info('Combined create-definition-and-log-first-entry transaction committed', {
        operation: 'createDefinitionAndLogFirstEntry',
        userId,
        definitionId: createdDef.id,
        entryId: loggedEntry.id,
        metricType: createdDef.metricType,
      });

      return {
        definition: createdDef,
        entry: loggedEntry,
      };
    });
  } catch (err: unknown) {
    logger.error('Transaction rollback in createDefinitionAndLogFirstEntry', {
      operation: 'createDefinitionAndLogFirstEntry',
      userId,
      metricType: defParams.metricType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
