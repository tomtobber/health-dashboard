import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../errors/AppError';
import {
  logManualEntry,
  updateManualEntry,
  deleteManualEntry,
  createDefinitionAndLogFirstEntry,
} from '../services/manualEntryService';
import { MetricValueType } from '../services/metricDefinitionService';
import {
  queryEnrichedMetricEntries,
  queryBatchEnrichedMetrics,
} from '../services/metricsQueryService';

export const manualEntryRouter = Router();

const logEntrySchema = z.object({
  definition_id: z.string().optional(),
  metric_type: z.string().optional(),
  start_time: z.string({ required_error: 'start_time is required' }),
  end_time: z.string().optional(),
  value_numeric: z.number().nullable().optional(),
  value_text: z.string().nullable().optional(),
  value_min: z.number().nullable().optional(),
  value_max: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  dimension: z.string().nullable().optional(),
});

const updateEntrySchema = z.object({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  value_numeric: z.number().nullable().optional(),
  value_text: z.string().nullable().optional(),
  value_min: z.number().nullable().optional(),
  value_max: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  dimension: z.string().nullable().optional(),
});

const combinedSchema = z.object({
  definition: z.object({
    metric_type: z.string({ required_error: 'definition.metric_type is required' }),
    display_name: z.string({ required_error: 'definition.display_name is required' }),
    value_type: z.enum(['numeric', 'duration', 'boolean', 'category']),
    unit: z.string().nullable().optional(),
    category_values: z.array(z.string()).nullable().optional(),
  }),
  entry: z.object({
    start_time: z.string({ required_error: 'entry.start_time is required' }),
    end_time: z.string().optional(),
    value_numeric: z.number().nullable().optional(),
    value_text: z.string().nullable().optional(),
    value_min: z.number().nullable().optional(),
    value_max: z.number().nullable().optional(),
    unit: z.string().nullable().optional(),
    dimension: z.string().nullable().optional(),
  }),
});

const queryEntriesSchema = z.object({
  metric_type: z.string().optional(),
  metric_types: z.string().optional(), // comma-separated for batching
  start_time: z.string({ required_error: 'start_time query parameter is required' }),
  end_time: z.string({ required_error: 'end_time query parameter is required' }),
  dimension: z.string().optional(),
  aggregation: z.string().optional(),
});

// 1. Query enriched metric entries (single or batch with definition metadata)
manualEntryRouter.get(
  '/',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = queryEntriesSchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError('Invalid metric query parameters', {
        operation: 'queryMetricEntriesRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const { metric_type, metric_types, start_time, end_time, dimension, aggregation } = parseResult.data;
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new ValidationError('start_time and end_time must be valid ISO date strings', {
        operation: 'queryMetricEntriesRoute',
        start_time,
        end_time,
      });
    }

    if (metric_types) {
      const typeList = metric_types
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const batchResults = await queryBatchEnrichedMetrics({
        userId: req.user!.id,
        metricTypes: typeList,
        startTime: startDate,
        endTime: endDate,
        dimension,
        aggregation,
      });

      return res.json({ metrics: batchResults });
    }

    if (!metric_type) {
      throw new ValidationError('Either metric_type or metric_types query parameter must be provided', {
        operation: 'queryMetricEntriesRoute',
      });
    }

    const singleResult = await queryEnrichedMetricEntries({
      userId: req.user!.id,
      metricType: metric_type,
      startTime: startDate,
      endTime: endDate,
      dimension,
      aggregation,
    });

    return res.json(singleResult);
  })
);

// 2. Log a manual metric entry
manualEntryRouter.post(
  '/manual',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = logEntrySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid manual metric entry payload', {
        operation: 'logManualEntryRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const {
      definition_id,
      metric_type,
      start_time,
      end_time,
      value_numeric,
      value_text,
      value_min,
      value_max,
      unit,
      dimension,
    } = parseResult.data;

    const startDate = new Date(start_time);
    const endDate = end_time ? new Date(end_time) : undefined;

    const entry = await logManualEntry({
      userId: req.user!.id,
      definitionId: definition_id,
      metricType: metric_type,
      startTime: startDate,
      endTime: endDate,
      valueNumeric: value_numeric,
      valueText: value_text,
      valueMin: value_min,
      valueMax: value_max,
      unit,
      dimension,
    });

    return res.status(201).json({ metricEntry: entry });
  })
);

// 3. Combined: create definition and log first entry in a transaction
manualEntryRouter.post(
  '/manual/combined',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = combinedSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid combined metric creation and entry payload', {
        operation: 'createAndLogCombinedRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const { definition, entry } = parseResult.data;
    const startDate = new Date(entry.start_time);
    const endDate = entry.end_time ? new Date(entry.end_time) : undefined;

    const result = await createDefinitionAndLogFirstEntry(
      {
        definition: {
          userId: req.user!.id,
          metricType: definition.metric_type,
          displayName: definition.display_name,
          valueType: definition.value_type as MetricValueType,
          unit: definition.unit,
          categoryValues: definition.category_values,
        },
        entry: {
          startTime: startDate,
          endTime: endDate,
          valueNumeric: entry.value_numeric,
          valueText: entry.value_text,
          valueMin: entry.value_min,
          valueMax: entry.value_max,
          unit: entry.unit,
          dimension: entry.dimension,
        },
      },
      req.user!.id
    );

    return res.status(201).json({
      metricDefinition: result.definition,
      metricEntry: result.entry,
    });
  })
);

// 4. Update an existing manual metric entry
manualEntryRouter.patch(
  '/manual/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = updateEntrySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid manual metric entry update payload', {
        operation: 'updateManualEntryRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const {
      start_time,
      end_time,
      value_numeric,
      value_text,
      value_min,
      value_max,
      unit,
      dimension,
    } = parseResult.data;

    const startDate = start_time ? new Date(start_time) : undefined;
    const endDate = end_time ? new Date(end_time) : undefined;

    const updated = await updateManualEntry({
      id: req.params.id,
      userId: req.user!.id,
      startTime: startDate,
      endTime: endDate,
      valueNumeric: value_numeric,
      valueText: value_text,
      valueMin: value_min,
      valueMax: value_max,
      unit,
      dimension,
    });

    return res.json({ metricEntry: updated });
  })
);

// 5. Soft-delete an existing manual metric entry
manualEntryRouter.delete(
  '/manual/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const result = await deleteManualEntry(req.params.id, req.user!.id);
    return res.json(result);
  })
);
