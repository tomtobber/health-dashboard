import { z } from 'zod';
import { db } from '../db';
import { dashboardViews, DashboardViewConfig, DashboardPanelConfig } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { ValidationError, NotFoundError, DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';

export const ChartPanelConfigSchema = z.object({
  id: z.string().min(1, 'Panel id is required'),
  panelType: z.literal('chart').optional().default('chart'),
  metricTypes: z.array(z.string().min(1)).min(1, 'At least one metricType is required'),
  timeRange: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('relative'),
      value: z.enum(['last_24h', 'last_7d', 'last_30d', 'last_90d', 'last_1y']),
    }),
    z.object({
      type: z.literal('absolute'),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
    }),
  ]),
  aggregation: z.enum(['raw', '1m_avg', '5m_avg', 'daily_avg', 'weekly_avg']),
  chartType: z.enum(['line', 'bar']).optional(),
});

export const BaselinePanelConfigSchema = z.object({
  id: z.string().min(1, 'Panel id is required'),
  panelType: z.literal('baseline'),
  metricType: z.string().min(1, 'metricType is required'),
});

export const PanelConfigSchema = z.union([
  BaselinePanelConfigSchema,
  ChartPanelConfigSchema,
]);


export function normalizeDashboardViewConfig(rawConfig: unknown): DashboardViewConfig {
  const parsed = DashboardViewConfigSchema.safeParse(rawConfig);
  if (parsed.success) {
    return parsed.data;
  }
  if (
    rawConfig &&
    typeof rawConfig === 'object' &&
    'panels' in rawConfig &&
    Array.isArray((rawConfig as Record<string, unknown>).panels)
  ) {
    const rawPanels = (rawConfig as Record<string, unknown>).panels as unknown[];
    return {
      panels: rawPanels.map((p) => {
        const panelObj = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        if (panelObj.panelType === 'baseline') {
          return panelObj as unknown as DashboardPanelConfig;
        }
        return {
          panelType: 'chart',
          ...panelObj,
        } as unknown as DashboardPanelConfig;
      }),
    };
  }
  return { panels: [] };
}

export const DashboardViewConfigSchema = z.object({
  panels: z.array(PanelConfigSchema).min(1, 'At least one panel is required'),
});

export interface CreateDashboardViewParams {
  userId: string;
  name: string;
  config: DashboardViewConfig;
}

export interface UpdateDashboardViewParams {
  id: string;
  userId: string;
  name?: string;
  config?: DashboardViewConfig;
}

export interface DashboardViewRecord {
  id: string;
  userId: string;
  name: string;
  config: DashboardViewConfig;
  createdAt: Date;
  updatedAt: Date;
}

export async function createDashboardView(
  params: CreateDashboardViewParams
): Promise<DashboardViewRecord> {
  const { userId, name, config } = params;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('name is required and must not be empty', {
      operation: 'createDashboardView',
      userId,
      name,
    });
  }

  const parsedConfig = DashboardViewConfigSchema.parse(config);

  try {
    const [created] = await db
      .insert(dashboardViews)
      .values({
        userId,
        name: name.trim(),
        config: parsedConfig,
      })
      .returning();

    logger.info('Dashboard view created successfully', {
      operation: 'createDashboardView',
      userId,
      viewId: created.id,
      name: created.name,
      panelCount: created.config.panels.length,
    });

    return {
      id: created.id,
      userId: created.userId,
      name: created.name,
      config: created.config,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  } catch (err: unknown) {
    const rawErr = err as { code?: string; cause?: { code?: string } };
    const pgCode = rawErr?.code || rawErr?.cause?.code;

    if (pgCode === '23505') {
      logger.warn('Unique constraint violation on dashboard_views (23505)', {
        operation: 'createDashboardView',
        userId,
        name: name.trim(),
      });
      throw new ValidationError(
        `A dashboard view with name '${name.trim()}' already exists for this user.`,
        { operation: 'createDashboardView', userId, name: name.trim(), code: '23505' }
      );
    }

    logger.error('Failed to create dashboard view', {
      operation: 'createDashboardView',
      userId,
      name,
      cause: err instanceof Error ? err.message : String(err),
    });

    throw new DatabaseError(
      'Failed to create dashboard view',
      {
        operation: 'createDashboardView',
        userId,
        name,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function listDashboardViews(userId: string): Promise<DashboardViewRecord[]> {
  try {
    const rows = await db
      .select()
      .from(dashboardViews)
      .where(eq(dashboardViews.userId, userId));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      config: normalizeDashboardViewConfig(r.config),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  } catch (err: unknown) {
    throw new DatabaseError('Failed to list dashboard views', {
      operation: 'listDashboardViews',
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function getDashboardView(id: string, userId: string): Promise<DashboardViewRecord> {
  try {
    const [view] = await db
      .select()
      .from(dashboardViews)
      .where(and(eq(dashboardViews.id, id), eq(dashboardViews.userId, userId)));

    if (!view) {
      logger.warn('Dashboard view not found or unauthorized', {
        operation: 'getDashboardView',
        id,
        userId,
      });
      throw new NotFoundError('Dashboard view not found or unauthorized', {
        operation: 'getDashboardView',
        id,
        userId,
      });
    }

    return {
      id: view.id,
      userId: view.userId,
      name: view.name,
      config: normalizeDashboardViewConfig(view.config),
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof NotFoundError) throw err;
    throw new DatabaseError('Failed to get dashboard view', {
      operation: 'getDashboardView',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    }, err);
  }
}

export async function updateDashboardView(
  params: UpdateDashboardViewParams
): Promise<DashboardViewRecord> {
  const { id, userId, name, config } = params;

  const [existing] = await db
    .select()
    .from(dashboardViews)
    .where(and(eq(dashboardViews.id, id), eq(dashboardViews.userId, userId)));

  if (!existing) {
    logger.warn('Dashboard view not found or unauthorized for update', {
      operation: 'updateDashboardView',
      id,
      userId,
    });
    throw new NotFoundError('Dashboard view not found or unauthorized', {
      operation: 'updateDashboardView',
      id,
      userId,
    });
  }

  const finalName = name !== undefined ? name.trim() : existing.name;
  if (!finalName) {
    throw new ValidationError('name cannot be empty', {
      operation: 'updateDashboardView',
      userId,
      id,
    });
  }

  let finalConfig = existing.config;
  if (config !== undefined) {
    finalConfig = DashboardViewConfigSchema.parse(config);
  }

  try {
    const [updated] = await db
      .update(dashboardViews)
      .set({
        name: finalName,
        config: finalConfig,
        updatedAt: new Date(),
      })
      .where(and(eq(dashboardViews.id, id), eq(dashboardViews.userId, userId)))
      .returning();

    logger.info('Dashboard view updated successfully', {
      operation: 'updateDashboardView',
      userId,
      viewId: id,
      name: updated.name,
    });

    return {
      id: updated.id,
      userId: updated.userId,
      name: updated.name,
      config: normalizeDashboardViewConfig(updated.config),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  } catch (err: unknown) {
    const rawErr = err as { code?: string; cause?: { code?: string } };
    const pgCode = rawErr?.code || rawErr?.cause?.code;

    if (pgCode === '23505') {
      logger.warn('Unique constraint violation on dashboard_views update (23505)', {
        operation: 'updateDashboardView',
        userId,
        viewId: id,
        name: finalName,
      });
      throw new ValidationError(
        `A dashboard view with name '${finalName}' already exists for this user.`,
        { operation: 'updateDashboardView', userId, id, name: finalName, code: '23505' }
      );
    }

    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;

    logger.error('Failed to update dashboard view', {
      operation: 'updateDashboardView',
      id,
      userId,
      cause: err instanceof Error ? err.message : String(err),
    });

    throw new DatabaseError(
      'Failed to update dashboard view',
      {
        operation: 'updateDashboardView',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}

export async function deleteDashboardView(
  id: string,
  userId: string
): Promise<{ success: boolean; message: string }> {
  const [existing] = await db
    .select()
    .from(dashboardViews)
    .where(and(eq(dashboardViews.id, id), eq(dashboardViews.userId, userId)));

  if (!existing) {
    logger.warn('Dashboard view not found or unauthorized for delete', {
      operation: 'deleteDashboardView',
      id,
      userId,
    });
    throw new NotFoundError('Dashboard view not found or unauthorized', {
      operation: 'deleteDashboardView',
      id,
      userId,
    });
  }

  try {
    await db
      .delete(dashboardViews)
      .where(and(eq(dashboardViews.id, id), eq(dashboardViews.userId, userId)));

    logger.info('Dashboard view deleted successfully', {
      operation: 'deleteDashboardView',
      userId,
      id,
      name: existing.name,
    });

    return {
      success: true,
      message: `Dashboard view '${existing.name}' successfully deleted`,
    };
  } catch (err: unknown) {
    if (err instanceof NotFoundError) throw err;
    throw new DatabaseError(
      'Failed to delete dashboard view',
      {
        operation: 'deleteDashboardView',
        id,
        userId,
        cause: err instanceof Error ? err.message : String(err),
      },
      err
    );
  }
}
