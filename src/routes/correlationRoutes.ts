import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError, AuthenticationError } from '../errors/AppError';
import { BaselineWindowSchema } from '../services/baselineService';
import { getMetricPairCorrelation } from '../services/correlationService';

export const correlationRouter = Router();

const CorrelationQuerySchema = z.object({
  metricTypeA: z.string().min(1, 'metricTypeA is required'),
  metricTypeB: z.string().min(1, 'metricTypeB is required'),
  windowDays: BaselineWindowSchema.shape.windowDays.optional(),
});

/**
 * GET /api/metrics/correlation?metricTypeA=...&metricTypeB=...&windowDays=...
 * Computes descriptive cross-metric Pearson correlation for an aligned UTC daily series.
 */
correlationRouter.get(
  '/correlation',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user?.id;
    if (!userId) {
      throw new AuthenticationError('User not authenticated for correlation calculation', {
        operation: 'getMetricCorrelationRoute',
      });
    }

    const queryParsed = CorrelationQuerySchema.safeParse({
      metricTypeA: req.query.metricTypeA,
      metricTypeB: req.query.metricTypeB,
      windowDays: req.query.windowDays !== undefined ? Number(req.query.windowDays) : undefined,
    });

    if (!queryParsed.success) {
      throw new ValidationError('Invalid correlation query parameters', {
        operation: 'getMetricCorrelationRoute',
        userId,
        zodErrors: queryParsed.error.errors,
      });
    }

    const { metricTypeA, metricTypeB, windowDays } = queryParsed.data;

    const result = await getMetricPairCorrelation(userId, metricTypeA, metricTypeB, windowDays);
    return res.json(result);
  })
);
