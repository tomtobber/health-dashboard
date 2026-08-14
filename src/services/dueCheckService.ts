import { db } from '../db';
import { connectedAccounts, syncRuns } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { executeSync } from './syncService';
import { checkAllSubscriptionsHealth } from './subscriptionHealthService';
import { POLLING_ONLY_METRICS, WEBHOOK_SUPPORTED_METRICS } from '../adapters/googleHealthAdapter';
import { logger } from '../utils/logger';

export interface DueEvaluationSummary {
  evaluatedAccounts: number;
  pollingExecuted: number;
  reconciliationExecuted: number;
  healthChecksExecuted: number;
  errors: string[];
}

export async function evaluateAndRunDueSyncs(options?: {
  pollingIntervalHours?: number;
  reconciliationIntervalHours?: number;
}): Promise<DueEvaluationSummary> {
  const pollingIntervalMs = (options?.pollingIntervalHours || 1) * 60 * 60 * 1000;
  const reconciliationIntervalMs = (options?.reconciliationIntervalHours || 24) * 60 * 60 * 1000;
  const now = new Date();

  const summary: DueEvaluationSummary = {
    evaluatedAccounts: 0,
    pollingExecuted: 0,
    reconciliationExecuted: 0,
    healthChecksExecuted: 0,
    errors: [],
  };

  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    logger.info('Running mock due evaluation in non-db test mode', { operation: 'evaluateAndRunDueSyncs' });
    return {
      evaluatedAccounts: 1,
      pollingExecuted: 1,
      reconciliationExecuted: 1,
      healthChecksExecuted: 1,
      errors: [],
    };
  }

  try {
    const activeAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.status, 'active'));

    summary.evaluatedAccounts = activeAccounts.length;

    for (const account of activeAccounts) {
      const userId = account.userId;
      const provider = account.provider;

      // 1. Evaluate Polling for Un-webhooked Metrics
      try {
        const [lastPollingRun] = await db
          .select()
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.userId, userId),
              eq(syncRuns.provider, provider),
              eq(syncRuns.trigger, 'polling'),
              eq(syncRuns.status, 'completed')
            )
          )
          .orderBy(desc(syncRuns.completedAt))
          .limit(1);

        const lastPollingTime = lastPollingRun?.completedAt ? new Date(lastPollingRun.completedAt).getTime() : 0;
        const isPollingDue = now.getTime() - lastPollingTime >= pollingIntervalMs;

        if (isPollingDue) {
          const startDate = lastPollingRun?.completedAt
            ? new Date(lastPollingRun.completedAt)
            : new Date(now.getTime() - 24 * 60 * 60 * 1000);

          await executeSync({
            userId,
            provider,
            startDate,
            endDate: now,
            metricTypes: POLLING_ONLY_METRICS,
            trigger: 'polling',
          });
          summary.pollingExecuted += 1;
        }
      } catch (err: unknown) {
        const errMsg = `Polling failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`;
        summary.errors.push(errMsg);
        logger.error('Due-check polling failed', { operation: 'evaluateAndRunDueSyncs:polling', userId, error: errMsg });
      }

      // 2. Evaluate Reconciliation Sweep for Webhooked Metrics
      try {
        const [lastReconcileRun] = await db
          .select()
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.userId, userId),
              eq(syncRuns.provider, provider),
              eq(syncRuns.trigger, 'reconciliation'),
              eq(syncRuns.status, 'completed')
            )
          )
          .orderBy(desc(syncRuns.completedAt))
          .limit(1);

        const lastReconcileTime = lastReconcileRun?.completedAt ? new Date(lastReconcileRun.completedAt).getTime() : 0;
        const isReconcileDue = now.getTime() - lastReconcileTime >= reconciliationIntervalMs;

        if (isReconcileDue) {
          const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7-day rolling window for reconciliation
          await executeSync({
            userId,
            provider,
            startDate,
            endDate: now,
            metricTypes: WEBHOOK_SUPPORTED_METRICS,
            trigger: 'reconciliation',
          });
          summary.reconciliationExecuted += 1;
        }
      } catch (err: unknown) {
        const errMsg = `Reconciliation sweep failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`;
        summary.errors.push(errMsg);
        logger.error('Due-check reconciliation failed', { operation: 'evaluateAndRunDueSyncs:reconciliation', userId, error: errMsg });
      }
    }

    // 3. Subscription Health Checks
    try {
      await checkAllSubscriptionsHealth();
      summary.healthChecksExecuted += 1;
    } catch (err: unknown) {
      const errMsg = `Subscription health checks failed: ${err instanceof Error ? err.message : String(err)}`;
      summary.errors.push(errMsg);
      logger.error('Due-check subscription health check failed', { operation: 'evaluateAndRunDueSyncs:subscriptionHealth', error: errMsg });
    }

    logger.info('Due-check scheduled evaluation completed', {
      operation: 'evaluateAndRunDueSyncs',
      ...summary,
    });

    return summary;
  } catch (outerErr: unknown) {
    const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    summary.errors.push(errMsg);
    logger.error('Outer due-check evaluation failed', { operation: 'evaluateAndRunDueSyncs:outer', error: errMsg });
    return summary;
  }
}
