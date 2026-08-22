import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { executeSync } from '../services/syncService';
import { getBackfillStatus } from '../services/backfillService';
import { evaluateAndRunDueSyncs } from '../services/dueCheckService';
import { queryMetricEntriesFromDb } from '../services/metricsQueryService';
import { db } from '../db';
import { syncRuns, metricEntries, metricDefinitions } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { env } from '../config/env';
import { safeTimingCompare } from '../services/cryptoService';
import { ValidationError, DatabaseError, AuthenticationError } from '../errors/AppError';
import { logger } from '../utils/logger';

export const syncRouter = Router();

const triggerSyncSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  metricTypes: z.array(z.string()).optional(),
});

const queryMetricsSchema = z.object({
  metricType: z.string({ required_error: 'metricType is required' }),
  startDate: z.string({ required_error: 'startDate is required' }),
  endDate: z.string({ required_error: 'endDate is required' }),
  aggregation: z.string().optional(),
});

function authenticateCronSecret(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const cronHeader = req.headers['x-cron-secret'];
  let providedSecret = '';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedSecret = authHeader.slice(7).trim();
  } else if (typeof cronHeader === 'string') {
    providedSecret = cronHeader.trim();
  }

  if (!providedSecret || !safeTimingCompare(providedSecret, env.CRON_SECRET)) {
    throw new AuthenticationError('Unauthorized: Invalid or missing cron secret', {
      operation: 'authenticateCronSecret',
      path: req.path,
    });
  }

  next();
}

// 1. Scheduled Background Cron Trigger (POST /api/sync/scheduled)
syncRouter.post(
  '/scheduled',
  authenticateCronSecret,
  asyncHandler(async (req: Request, res: Response): Promise<unknown> => {
    logger.info('Received scheduled sync due-check trigger', {
      operation: 'scheduledSyncTrigger',
      ip: req.ip,
    });

    const summary = await evaluateAndRunDueSyncs();

    return res.status(200).json({
      status: 'ok',
      message: 'Scheduled due-check evaluation completed',
      summary,
    });
  })
);

// 2. Trigger Manual Sync (POST /api/sync/trigger)
syncRouter.post(
  '/trigger',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = triggerSyncSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid sync trigger parameters', {
        operation: 'triggerSync',
        zodErrors: parseResult.error.errors,
      });
    }

    const userId = req.user!.id;
    const now = new Date();
    const startDate = parseResult.data.startDate ? new Date(parseResult.data.startDate) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const endDate = parseResult.data.endDate ? new Date(parseResult.data.endDate) : now;

    const result = await executeSync({
      userId,
      startDate,
      endDate,
      metricTypes: parseResult.data.metricTypes,
      trigger: 'polling',
    });

    return res.json({
      message: 'Sync completed successfully',
      syncRunId: result.syncRunId,
      pointsFetched: result.pointsFetched,
      pointsUpserted: result.pointsUpserted,
      status: result.status,
    });
  })
);

// 3. Query Sync Status and History (GET /api/sync/status)
syncRouter.get(
  '/status',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;
    const backfill = getBackfillStatus(userId);

    const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

    if (!isLiveDb) {
      return res.json({
        backfillStatus: backfill,
        syncRuns: [
          {
            id: 'mock_run_1',
            provider: 'google_health',
            trigger: 'polling',
            status: 'completed',
            pointsFetched: 10,
            pointsUpserted: 10,
            startedAt: new Date(),
          },
        ],
      });
    }

    try {
      const runs = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.userId, userId))
        .orderBy(desc(syncRuns.startedAt))
        .limit(20);

      return res.json({
        backfillStatus: backfill,
        syncRuns: runs,
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to query sync runs status', {
        operation: 'getSyncStatus',
        userId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  })
);

// 4. Query Backfill Status Specifically (GET /api/sync/backfill/status)
syncRouter.get(
  '/backfill/status',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;
    const backfill = getBackfillStatus(userId);
    return res.json({
      ...backfill,
      userId,
    });
  })
);

// 5. Query Normalized Metrics (GET /api/sync/metrics)
syncRouter.get(
  '/metrics',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = queryMetricsSchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError('Invalid query metrics parameters', {
        operation: 'queryMetrics',
        zodErrors: parseResult.error.errors,
      });
    }

    const userId = req.user!.id;
    const { metricType, startDate, endDate, aggregation } = parseResult.data;

    const entries = await queryMetricEntriesFromDb({
      userId,
      metricType,
      startTime: new Date(startDate),
      endTime: new Date(endDate),
      aggregation,
    });

    return res.json({
      userId,
      metricType,
      count: entries.length,
      entries,
    });
  })
);


// 4. Seed 14 days of realistic demo health data for the current user
syncRouter.post(
  '/seed-demo',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;
    const now = Date.now();

    // Ensure custom metric definitions exist for the user
    try {
      await db.insert(metricDefinitions).values([
        {
          userId,
          metricType: 'water-intake',
          displayName: 'Water Intake',
          valueType: 'numeric',
          unit: 'ml',
        },
        {
          userId,
          metricType: 'workout-completed',
          displayName: 'Daily Workout',
          valueType: 'boolean',
          unit: null,
        },
        {
          userId,
          metricType: 'mood',
          displayName: 'Daily Mood',
          valueType: 'category',
          categoryValues: ['energized', 'calm', 'focused', 'tired', 'stressed'],
        },
      ]).onConflictDoNothing();
    } catch {
      // Definitions may already exist
    }

    const sampleEntries: Array<typeof metricEntries.$inferInsert> = [];

    for (let i = 13; i >= 0; i--) {
      const dayStart = new Date(now - i * 24 * 60 * 60 * 1000);
      dayStart.setUTCHours(8, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 12 * 60 * 60 * 1000);

      // Steps
      sampleEntries.push({
        userId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: `demo-steps-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayEnd,
        valueNumeric: 7000 + Math.floor(Math.sin(i) * 2500) + (i % 4) * 600,
        unit: 'count',
        dimension: 'default',
        sourceStream: 'reconciled',
        aggregation: 'daily_sum',
      });

      // Heart rate
      sampleEntries.push({
        userId,
        provider: 'google_health',
        metricType: 'heart-rate',
        externalId: `demo-hr-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayEnd,
        valueNumeric: 72 + Math.floor(Math.cos(i) * 6),
        valueMin: 58,
        valueMax: 135,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'reconciled',
        aggregation: 'daily_avg',
      });

      // Resting Heart Rate
      sampleEntries.push({
        userId,
        provider: 'google_health',
        metricType: 'daily-resting-heart-rate',
        externalId: `demo-rhr-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayEnd,
        valueNumeric: 61 + Math.floor(Math.sin(i * 0.5) * 3),
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'reconciled',
        aggregation: 'daily_avg',
      });

      // Sleep
      sampleEntries.push({
        userId,
        provider: 'google_health',
        metricType: 'sleep',
        externalId: `demo-sleep-${userId}-${i}`,
        startTime: new Date(dayStart.getTime() - 8 * 3600000),
        endTime: dayStart,
        valueNumeric: 440 + Math.floor(Math.sin(i * 1.2) * 50),
        unit: 'minutes',
        dimension: 'default',
        sourceStream: 'reconciled',
        aggregation: 'daily_sum',
      });

      // HRV
      sampleEntries.push({
        userId,
        provider: 'google_health',
        metricType: 'daily-heart-rate-variability',
        externalId: `demo-hrv-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayEnd,
        valueNumeric: 50 + Math.floor(Math.cos(i * 0.7) * 9),
        unit: 'ms',
        dimension: 'default',
        sourceStream: 'reconciled',
        aggregation: 'daily_avg',
      });

      // Custom metric: Water Intake (numeric)
      sampleEntries.push({
        userId,
        provider: 'manual',
        metricType: 'water-intake',
        externalId: `demo-water-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayEnd,
        valueNumeric: 2100 + (i % 3) * 400,
        unit: 'ml',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: 'daily_sum',
      });

      // Custom metric: Workout (boolean)
      if (i % 2 === 0) {
        sampleEntries.push({
          userId,
          provider: 'manual',
          metricType: 'workout-completed',
          externalId: `demo-workout-${userId}-${i}`,
          startTime: dayStart,
          endTime: dayStart,
          valueNumeric: 1,
          unit: null,
          dimension: 'default',
          sourceStream: 'raw',
          aggregation: 'raw',
        });
      }

      // Custom metric: Mood (category)
      const moods = ['energized', 'calm', 'focused', 'calm', 'energized'];
      sampleEntries.push({
        userId,
        provider: 'manual',
        metricType: 'mood',
        externalId: `demo-mood-${userId}-${i}`,
        startTime: dayStart,
        endTime: dayStart,
        valueNumeric: null,
        valueText: moods[i % moods.length],
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: 'raw',
      });
    }

    try {
      await db.insert(metricEntries).values(sampleEntries).onConflictDoNothing();
      logger.info('Demo health data seeded successfully', {
        operation: 'seedDemoHealthData',
        userId,
        entriesCount: sampleEntries.length,
      });
      return res.json({ success: true, count: sampleEntries.length, message: '14 days of demo health metrics seeded successfully' });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to seed demo health metrics', {
        operation: 'seedDemoHealthData',
        userId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  })
);
