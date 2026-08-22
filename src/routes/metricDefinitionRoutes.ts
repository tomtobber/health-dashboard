import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../errors/AppError';
import {
  createMetricDefinition,
  getMetricDefinition,
  listMetricDefinitions,
  updateMetricDefinition,
  archiveMetricDefinition,
  deleteMetricDefinition,
  MetricValueType,
} from '../services/metricDefinitionService';

export const metricDefinitionRouter = Router();

const createDefinitionSchema = z.object({
  metric_type: z.string({ required_error: 'metric_type is required' }),
  display_name: z.string({ required_error: 'display_name is required' }),
  value_type: z.enum(['numeric', 'duration', 'boolean', 'category'], {
    required_error: 'value_type must be numeric, duration, boolean, or category',
  }),
  unit: z.string().nullable().optional(),
  category_values: z.array(z.string()).nullable().optional(),
});

const updateDefinitionSchema = z.object({
  display_name: z.string().optional(),
  value_type: z.enum(['numeric', 'duration', 'boolean', 'category']).optional(),
  unit: z.string().nullable().optional(),
  category_values: z.array(z.string()).nullable().optional(),
});

// 1. Create a custom metric definition
metricDefinitionRouter.post(
  '/',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = createDefinitionSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid metric definition creation payload', {
        operation: 'createMetricDefinitionRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const { metric_type, display_name, value_type, unit, category_values } = parseResult.data;
    const created = await createMetricDefinition({
      userId: req.user!.id,
      metricType: metric_type,
      displayName: display_name,
      valueType: value_type as MetricValueType,
      unit,
      categoryValues: category_values,
    });

    return res.status(201).json({ metricDefinition: created });
  })
);

// 2. List metric definitions for user
metricDefinitionRouter.get(
  '/',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const includeArchived = req.query.includeArchived === 'true';
    const definitions = await listMetricDefinitions(req.user!.id, includeArchived);
    return res.json({ metricDefinitions: definitions });
  })
);

// 3. Get single metric definition by ID
metricDefinitionRouter.get(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const definition = await getMetricDefinition(req.params.id, req.user!.id);
    return res.json({ metricDefinition: definition });
  })
);

// 4. Update metric definition
metricDefinitionRouter.patch(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = updateDefinitionSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid metric definition update payload', {
        operation: 'updateMetricDefinitionRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const { display_name, value_type, unit, category_values } = parseResult.data;
    const updated = await updateMetricDefinition({
      id: req.params.id,
      userId: req.user!.id,
      displayName: display_name,
      valueType: value_type as MetricValueType | undefined,
      unit,
      categoryValues: category_values,
    });

    return res.json({ metricDefinition: updated });
  })
);

// 5. Soft-archive metric definition
metricDefinitionRouter.post(
  '/:id/archive',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const archived = await archiveMetricDefinition(req.params.id, req.user!.id);
    return res.json({ metricDefinition: archived });
  })
);

// 6. Delete metric definition (allowed only if 0 entries exist)
metricDefinitionRouter.delete(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const result = await deleteMetricDefinition(req.params.id, req.user!.id);
    return res.json(result);
  })
);
