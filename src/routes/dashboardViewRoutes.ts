import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../errors/AppError';
import {
  createDashboardView,
  getDashboardView,
  listDashboardViews,
  updateDashboardView,
  deleteDashboardView,
  DashboardViewConfigSchema,
} from '../services/dashboardViewService';

export const dashboardViewRouter = Router();

const createDashboardViewSchema = z.object({
  name: z.string({ required_error: 'name is required' }).min(1, 'name must not be empty'),
  config: DashboardViewConfigSchema,
});

const updateDashboardViewSchema = z.object({
  name: z.string().min(1, 'name must not be empty').optional(),
  config: DashboardViewConfigSchema.optional(),
});

// 1. Create a dashboard view
dashboardViewRouter.post(
  '/',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = createDashboardViewSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid dashboard view creation payload', {
        operation: 'createDashboardViewRoute',
        zodErrors: parseResult.error.errors,
      });
    }

    const { name, config } = parseResult.data;
    const created = await createDashboardView({
      userId: req.user!.id,
      name,
      config,
    });

    return res.status(201).json({ dashboardView: created });
  })
);

// 2. List dashboard views for user
dashboardViewRouter.get(
  '/',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const views = await listDashboardViews(req.user!.id);
    return res.status(200).json({ dashboardViews: views });
  })
);

// 3. Get single dashboard view
dashboardViewRouter.get(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const view = await getDashboardView(req.params.id, req.user!.id);
    return res.status(200).json({ dashboardView: view });
  })
);

// 4. Update dashboard view
dashboardViewRouter.patch(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = updateDashboardViewSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid dashboard view update payload', {
        operation: 'updateDashboardViewRoute',
        id: req.params.id,
        zodErrors: parseResult.error.errors,
      });
    }

    const { name, config } = parseResult.data;
    const updated = await updateDashboardView({
      id: req.params.id,
      userId: req.user!.id,
      name,
      config,
    });

    return res.status(200).json({ dashboardView: updated });
  })
);

// 5. Delete dashboard view
dashboardViewRouter.delete(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const result = await deleteDashboardView(req.params.id, req.user!.id);
    return res.status(200).json(result);
  })
);
