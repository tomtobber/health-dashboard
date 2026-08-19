import { db } from '../db';
import { syncRuns, metricEntries, connectedAccounts } from '../db/schema';
import { eq, and, gte, lte, isNull, inArray } from 'drizzle-orm';
import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { SyncParams, SyncResult, NormalizedMetricEntry } from '../adapters/baseAdapter';
import { downsampleEntries } from './downsamplingService';
import { encryptToken, decryptToken } from './cryptoService';
import { DatabaseError, NotFoundError, ExternalServiceError } from '../errors/AppError';
import { logger } from '../utils/logger';

export interface ExecuteSyncOptions extends SyncParams {
  provider?: string;
  trigger: 'webhook' | 'reconciliation' | 'polling' | 'backfill';
  downsampleBucketMinutes?: number;
}

export interface SyncExecutionResult {
  syncRunId: string;
  pointsFetched: number;
  pointsUpserted: number;
  pointsSoftDeleted?: number;
  pagesFetched: number;
  status: 'completed' | 'failed';
  entries: NormalizedMetricEntry[];
}

export async function executeSync(options: ExecuteSyncOptions): Promise<SyncExecutionResult> {
  const providerName = options.provider || 'google_health';
  const adapter = new GoogleHealthAdapter();

  let syncRunId: string;
  try {
    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
      syncRunId = 'mock_sync_run_' + Date.now();
    } else {
      const [runRecord] = await db.insert(syncRuns).values({
        userId: options.userId,
        provider: providerName,
        metricType: options.metricTypes ? options.metricTypes.join(',') : 'all',
        trigger: options.trigger,
        requestedRangeStart: options.startDate,
        requestedRangeEnd: options.endDate,
        status: 'in_progress',
        startedAt: new Date(),
      }).returning({ id: syncRuns.id });
      syncRunId = runRecord.id;
    }
  } catch (err: unknown) {
    throw new DatabaseError('Failed to initialize sync_runs audit log', {
      operation: 'executeSync:initAudit',
      userId: options.userId,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    let accountRecord: typeof connectedAccounts.$inferSelect | undefined;
    let accessToken = options.accessToken;
    if (!accessToken && (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL?.includes('neon.tech'))) {
      const [account] = await db.select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, options.userId), eq(connectedAccounts.provider, providerName)));
      
      if (!account) {
        throw new NotFoundError('No connected account found for provider ' + providerName, {
          operation: 'executeSync:findAccount',
          userId: options.userId,
        });
      }
      accountRecord = account;
      accessToken = decryptToken(account.accessToken);
    }

    let syncResult: SyncResult;
    try {
      syncResult = await adapter.sync({
        ...options,
        accessToken: accessToken || 'mock_token',
      });
    } catch (syncErr: unknown) {
      const is401 =
        syncErr instanceof ExternalServiceError &&
        (syncErr.upstreamStatusCode === 401 ||
          syncErr.statusCode === 401 ||
          syncErr.message.includes('401') ||
          syncErr.message.includes('UNAUTHENTICATED'));

      if (is401) {
        if (!accountRecord && (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL?.includes('neon.tech'))) {
          const [found] = await db
            .select()
            .from(connectedAccounts)
            .where(and(eq(connectedAccounts.userId, options.userId), eq(connectedAccounts.provider, providerName)));
          accountRecord = found;
        }

        if (accountRecord?.refreshToken) {
          logger.info('OAuth access token expired (upstream 401), automatically refreshing with refresh_token', {
            operation: 'executeSync:autoRefresh',
            userId: options.userId,
          });
          const decryptedRefreshToken = decryptToken(accountRecord.refreshToken);
          const refreshed = await adapter.refreshToken(decryptedRefreshToken);
          accessToken = refreshed.accessToken;

          // Persist refreshed access token (and new refresh token if rotated) to database
          await db
            .update(connectedAccounts)
            .set({
              accessToken: encryptToken(refreshed.accessToken),
              refreshToken: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : accountRecord.refreshToken,
              updatedAt: new Date(),
            })
            .where(eq(connectedAccounts.id, accountRecord.id));

          // Retry sync with the fresh access token
          syncResult = await adapter.sync({
            ...options,
            accessToken,
          });
        } else {
          throw syncErr;
        }
      } else {
        throw syncErr;
      }
    }

    const rawEntries = syncResult.mappedEntries || [];
    const downsampledEntries = downsampleEntries(rawEntries, options.downsampleBucketMinutes || 1);

    let pointsUpserted = 0;
    let pointsSoftDeleted = 0;

    const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

    if (isLiveDb && downsampledEntries.length > 0) {
      for (const entry of downsampledEntries) {
        const externalId = entry.externalId || `gh_${entry.metricType}_${entry.startTime.getTime()}`;
        
        await db.insert(metricEntries).values({
          userId: entry.userId,
          provider: entry.provider,
          metricType: entry.metricType,
          externalId,
          startTime: entry.startTime,
          endTime: entry.endTime,
          valueNumeric: entry.valueNumeric,
          valueText: entry.valueText ?? null,
          unit: entry.unit,
          sourceStream: entry.sourceStream,
          aggregation: entry.aggregation,
          rawPayload: entry.rawPayload,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: [
            metricEntries.userId,
            metricEntries.provider,
            metricEntries.metricType,
            metricEntries.sourceStream,
            metricEntries.externalId,
          ],
          set: {
            valueNumeric: entry.valueNumeric,
            valueText: entry.valueText ?? null,
            unit: entry.unit,
            startTime: entry.startTime,
            endTime: entry.endTime,
            aggregation: entry.aggregation,
            rawPayload: entry.rawPayload,
            updatedAt: new Date(),
            deletedAt: null,
          },
        });
        pointsUpserted += 1;
      }
    } else {
      pointsUpserted = downsampledEntries.length;
    }

    // Reconciliation Sweep Soft Deletion Handling
    if (isLiveDb && options.trigger === 'reconciliation' && options.metricTypes && options.metricTypes.length > 0) {
      for (const mType of options.metricTypes) {
        const existingEntries = await db
          .select({
            id: metricEntries.id,
            externalId: metricEntries.externalId,
            startTime: metricEntries.startTime,
            endTime: metricEntries.endTime,
            sourceStream: metricEntries.sourceStream,
          })
          .from(metricEntries)
          .where(
            and(
              eq(metricEntries.userId, options.userId),
              eq(metricEntries.provider, providerName),
              eq(metricEntries.metricType, mType),
              gte(metricEntries.startTime, options.startDate),
              lte(metricEntries.endTime, options.endDate),
              isNull(metricEntries.deletedAt)
            )
          );

        // Find which existing points are no longer in the fetched batch
        const fetchedExternalIds = new Set(
          rawEntries.filter((e) => e.metricType === mType && e.externalId).map((e) => e.externalId)
        );

        const idsToSoftDelete: string[] = [];
        for (const existing of existingEntries) {
          if (existing.sourceStream === 'raw' && existing.externalId) {
            if (!fetchedExternalIds.has(existing.externalId)) {
              idsToSoftDelete.push(existing.id);
            }
          }
        }

        if (idsToSoftDelete.length > 0) {
          await db
            .update(metricEntries)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(inArray(metricEntries.id, idsToSoftDelete));
          pointsSoftDeleted += idsToSoftDelete.length;
          logger.info('Reconciliation soft-deleted missing remote points', {
            operation: 'executeSync:reconciliationSoftDelete',
            userId: options.userId,
            metricType: mType,
            softDeletedCount: idsToSoftDelete.length,
          });
        }
      }
    }

    // Divergence Check Logging
    logRawVsReconciledDivergence(downsampledEntries, options.userId);

    if (isLiveDb && syncRunId) {
      await db.update(syncRuns).set({
        status: 'completed',
        pointsFetched: syncResult.pointsFetched,
        pointsUpserted,
        pagesFetched: syncResult.pagesFetched || 1,
        completedAt: new Date(),
      }).where(eq(syncRuns.id, syncRunId));
    }

    logger.info('Sync execution completed successfully', {
      operation: 'executeSync',
      userId: options.userId,
      trigger: options.trigger,
      syncRunId,
      pointsFetched: syncResult.pointsFetched,
      pointsUpserted,
      pointsSoftDeleted,
    });

    return {
      syncRunId,
      pointsFetched: syncResult.pointsFetched,
      pointsUpserted,
      pointsSoftDeleted,
      pagesFetched: syncResult.pagesFetched || 1,
      status: 'completed',
      entries: downsampledEntries,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));
    if (isLiveDb && syncRunId) {
      await db.update(syncRuns).set({
        status: 'failed',
        error: errorMessage,
        completedAt: new Date(),
      }).where(eq(syncRuns.id, syncRunId)).catch((dbErr) => {
        logger.error('Failed to log failed sync status to sync_runs', {
          operation: 'executeSync:logFailure',
          syncRunId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      });
    }

    logger.error('Sync execution failed', {
      operation: 'executeSync',
      userId: options.userId,
      trigger: options.trigger,
      error: errorMessage,
    });
    throw error;
  }
}

function logRawVsReconciledDivergence(entries: NormalizedMetricEntry[], userId: string): void {
  const rawMap = new Map<string, number>();
  const reconciledMap = new Map<string, number>();

  for (const entry of entries) {
    if (entry.valueNumeric === undefined) continue;
    const key = `${entry.metricType}|${entry.startTime.toISOString()}`;
    if (entry.sourceStream === 'raw') {
      rawMap.set(key, entry.valueNumeric);
    } else if (entry.sourceStream === 'reconciled') {
      reconciledMap.set(key, entry.valueNumeric);
    }
  }

  for (const [key, reconciledVal] of reconciledMap.entries()) {
    const rawVal = rawMap.get(key);
    if (rawVal !== undefined && Math.abs(rawVal - reconciledVal) > 0.01) {
      const [metricType, time] = key.split('|');
      logger.info('Raw vs reconciled divergence detected', {
        operation: 'divergenceCheck',
        userId,
        metricType,
        time,
        rawVal,
        reconciledVal,
        delta: Math.abs(rawVal - reconciledVal),
      });
    }
  }
}
