import { executeSync } from './syncService';
import { splitDateRange } from '../adapters/googleHealthAdapter';
import { logger } from '../utils/logger';

export interface BackfillJobState {
  userId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  totalDays: number;
  processedWindows: number;
  totalWindows: number;
  pointsFetched: number;
  pointsUpserted: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

const backfillJobs = new Map<string, BackfillJobState>();

export function triggerInitialBackfill(userId: string, daysOfHistory: number = 365): void {
  const now = new Date();
  const startDate = new Date(now.getTime() - daysOfHistory * 24 * 60 * 60 * 1000);

  // Divide into 14-day execution windows
  const windows = splitDateRange(startDate, now, 14);

  const initialState: BackfillJobState = {
    userId,
    status: 'in_progress',
    totalDays: daysOfHistory,
    processedWindows: 0,
    totalWindows: windows.length,
    pointsFetched: 0,
    pointsUpserted: 0,
    startedAt: now,
  };
  backfillJobs.set(userId, initialState);

  logger.info('Initiating async 1-year historical backfill job', {
    operation: 'triggerInitialBackfill',
    userId,
    daysOfHistory,
    totalWindows: windows.length,
  });

  // Run asynchronously without blocking caller
  setImmediate(() => {
    void (async () => {
      let totalFetched = 0;
      let totalUpserted = 0;

      try {
        for (let i = 0; i < windows.length; i++) {
          const win = windows[i];
          const syncResult = await executeSync({
            userId,
            startDate: win.start,
            endDate: win.end,
            trigger: 'backfill',
          });

          totalFetched += syncResult.pointsFetched;
          totalUpserted += syncResult.pointsUpserted;

          backfillJobs.set(userId, {
            userId,
            status: i === windows.length - 1 ? 'completed' : 'in_progress',
            totalDays: daysOfHistory,
            processedWindows: i + 1,
            totalWindows: windows.length,
            pointsFetched: totalFetched,
            pointsUpserted: totalUpserted,
            startedAt: now,
            completedAt: i === windows.length - 1 ? new Date() : undefined,
          });

          logger.info(`Backfill window ${i + 1}/${windows.length} completed`, {
            operation: 'triggerInitialBackfill:window',
            userId,
            windowIndex: i + 1,
            totalWindows: windows.length,
            fetched: syncResult.pointsFetched,
            upserted: syncResult.pointsUpserted,
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        backfillJobs.set(userId, {
          userId,
          status: 'failed',
          totalDays: daysOfHistory,
          processedWindows: 0,
          totalWindows: windows.length,
          pointsFetched: totalFetched,
          pointsUpserted: totalUpserted,
          startedAt: now,
          completedAt: new Date(),
          error: errMsg,
        });
        logger.error('Initial backfill background job failed', {
          operation: 'triggerInitialBackfill:asyncWorker',
          userId,
          error: errMsg,
        });
      }
    })();
  });
}

export function getBackfillStatus(userId: string): BackfillJobState {
  const existing = backfillJobs.get(userId);
  if (existing) {
    return existing;
  }
  return {
    userId,
    status: 'pending',
    totalDays: 0,
    processedWindows: 0,
    totalWindows: 0,
    pointsFetched: 0,
    pointsUpserted: 0,
    startedAt: new Date(),
  };
}
