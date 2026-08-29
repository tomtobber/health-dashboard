import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../errors/AppError';
import {
  getMetricBaseline,
  getMetricTrend,
  getBaselineConfig,
  setBaselineConfig,
  BaselineWindowSchema,
} from '../services/baselineService';

export const baselineRouter = Router();

// GET /api/metrics/:metricType/baseline
baselineRouter.get(
  '/:metricType/baseline',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const { metricType } = req.params;
    if (!metricType) {
      throw new ValidationError('metricType parameter is required', {
        operation: 'getMetricBaselineRoute',
      });
    }

    let windowDaysOverride: number | undefined;
    if (req.query.windowDays !== undefined) {
      const parseResult = BaselineWindowSchema.safeParse({
        windowDays: req.query.windowDays,
      });

      if (!parseResult.success) {
        throw new ValidationError('Invalid windowDays query parameter', {
          operation: 'getMetricBaselineRoute',
          zodErrors: parseResult.error.errors,
        });
      }

      windowDaysOverride = parseResult.data.windowDays;
    }

    const baseline = await getMetricBaseline(req.user!.id, metricType, windowDaysOverride);
    return res.status(200).json(baseline);
  })
);

// GET /api/metrics/:metricType/trend
baselineRouter.get(
  '/:metricType/trend',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const { metricType } = req.params;
    if (!metricType) {
      throw new ValidationError('metricType parameter is required', {
        operation: 'getMetricTrendRoute',
      });
    }

    let windowDaysOverride: number | undefined;
    if (req.query.windowDays !== undefined) {
      const parseResult = BaselineWindowSchema.safeParse({
        windowDays: req.query.windowDays,
      });

      if (!parseResult.success) {
        throw new ValidationError('Invalid windowDays query parameter', {
          operation: 'getMetricTrendRoute',
          zodErrors: parseResult.error.errors,
        });
      }

      windowDaysOverride = parseResult.data.windowDays;
    }

    const trend = await getMetricTrend(req.user!.id, metricType, windowDaysOverride);
    return res.status(200).json(trend);
  })
);

// GET /api/metrics/:metricType/baseline-config
baselineRouter.get(
  '/:metricType/baseline-config',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const { metricType } = req.params;
    if (!metricType) {
      throw new ValidationError('metricType parameter is required', {
        operation: 'getBaselineConfigRoute',
      });
    }

    const config = await getBaselineConfig(req.user!.id, metricType);
    return res.status(200).json(config);
  })
);

// PUT /api/metrics/:metricType/baseline-config
baselineRouter.put(
  '/:metricType/baseline-config',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const { metricType } = req.params;
    if (!metricType) {
      throw new ValidationError('metricType parameter is required', {
        operation: 'setBaselineConfigRoute',
      });
    }

    const parseResult = BaselineWindowSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid baseline config payload', {
        operation: 'setBaselineConfigRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const updated = await setBaselineConfig(
      req.user!.id,
      metricType,
      parseResult.data.windowDays
    );

    return res.status(200).json(updated);
  })
);
