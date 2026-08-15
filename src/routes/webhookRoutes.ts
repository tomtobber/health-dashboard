import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { executeSync } from '../services/syncService';
import { logger } from '../utils/logger';
import { AuthenticationError, ValidationError, NotFoundError } from '../errors/AppError';
import { safeTimingCompare } from '../services/cryptoService';
import { env } from '../config/env';
import { db as defaultDb } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema';

export const webhookRouter = Router();

const webhookPayloadSchema = z.object({
  healthUserId: z.string().optional(),
  userId: z.string().optional(),
  dataType: z.string().optional(),
  metricType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  operation: z.string().optional(),
  clientProvidedSubscriptionName: z.string().optional(),
}).refine(data => Boolean(data.healthUserId?.trim() || data.userId?.trim()), {
  message: 'Either healthUserId or userId must be provided in webhook notification payload',
}).refine(data => Boolean(data.dataType?.trim() || data.metricType?.trim()), {
  message: 'Either dataType or metricType must be provided in webhook notification payload',
});

function authenticateWebhookRequest(req: Request): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    throw new AuthenticationError('Unauthorized: Missing webhook authorization token', {
      operation: 'authenticateWebhookRequest',
      path: req.path,
    });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const expectedSecret = env.WEBHOOK_AUTH_TOKEN;

  if (!safeTimingCompare(token, expectedSecret)) {
    throw new AuthenticationError('Unauthorized: Invalid webhook authorization token', {
      operation: 'authenticateWebhookRequest',
      path: req.path,
    });
  }
}

/**
 * Resolves the exact local user_id from Google Health webhook payload.
 * Strictly queries connected_accounts matching healthUserId or userId.
 * NEVER guesses or falls back to an arbitrary active account.
 * Runs identically in all environments without branching on DATABASE_URL.
 */
export async function resolveLocalUserId(
  payloadUserId?: string,
  healthUserId?: string,
  dbInstance: NodePgDatabase<typeof schema> = defaultDb
): Promise<string> {
  const trimmedHealthId = healthUserId?.trim();
  const trimmedPayloadId = payloadUserId?.trim();

  // 1. Mandatory Guard: If neither identifier is present, reject immediately before DB query
  if (!trimmedHealthId && !trimmedPayloadId) {
    logger.warn('Unattributable webhook notification discarded: missing both healthUserId and payloadUserId', {
      operation: 'resolveLocalUserId',
    });
    throw new NotFoundError('Unattributable webhook notification: missing both healthUserId and payloadUserId', {
      operation: 'resolveLocalUserId',
    });
  }

  // 2. Build exact lookup conditions
  const conditions = [];
  if (trimmedHealthId) {
    conditions.push(eq(connectedAccounts.healthUserId, trimmedHealthId));
  }
  if (trimmedPayloadId) {
    conditions.push(eq(connectedAccounts.userId, trimmedPayloadId));
  }

  const [account] = await dbInstance
    .select({
      userId: connectedAccounts.userId,
      status: connectedAccounts.status,
      healthUserId: connectedAccounts.healthUserId,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.status, 'active'),
        eq(connectedAccounts.provider, 'google_health'),
        or(...conditions)
      )
    )
    .limit(1);

  if (!account) {
    logger.warn('Unattributable webhook notification discarded: no active connected account matches healthUserId or userId', {
      operation: 'resolveLocalUserId',
      healthUserId: trimmedHealthId,
      payloadUserId: trimmedPayloadId,
    });
    throw new NotFoundError('Unattributable webhook notification: no matching active connected account found', {
      operation: 'resolveLocalUserId',
      healthUserId: trimmedHealthId,
      payloadUserId: trimmedPayloadId,
    });
  }

  return account.userId;
}

// 1. Google Webhook Challenge Verification (GET)
webhookRouter.get('/google', (req: Request, res: Response) => {
  const challenge = req.query['hub.challenge'] || req.query.challenge;
  if (challenge) {
    logger.info('Google Health webhook verification challenge received', {
      operation: 'googleWebhookChallenge',
    });
    return res.status(200).send(String(challenge));
  }
  return res.status(200).json({ status: 'ok', message: 'Google Health webhook endpoint active' });
});

// 2. Google Webhook Notification Handler (POST)
webhookRouter.post(
  '/google',
  asyncHandler(async (req: Request, res: Response): Promise<unknown> => {
    // Authenticate authorization_token configured during subscriber creation
    authenticateWebhookRequest(req);

    const parseResult = webhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid Google webhook payload', {
        operation: 'googleWebhookHandler',
        zodErrors: parseResult.error.errors,
      });
    }

    const { userId: payloadUserId, healthUserId, metricType: pMetric, dataType: pData, startDate, endDate, startTime, endTime } = parseResult.data;
    const resolvedMetricType = pMetric || pData || 'heart_rate';
    const rawStart = startDate || startTime;
    const rawEnd = endDate || endTime;

    const now = new Date();
    const syncStart = rawStart ? new Date(rawStart) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const syncEnd = rawEnd ? new Date(rawEnd) : now;

    // Strict exact attribution (throws NotFoundError if unmatched; discarded)
    const localUserId = await resolveLocalUserId(payloadUserId, healthUserId);

    logger.info('Received and authenticated Google Health webhook notification', {
      operation: 'googleWebhookHandler',
      localUserId,
      healthUserId,
      metricType: resolvedMetricType,
      window: { start: syncStart.toISOString(), end: syncEnd.toISOString() },
    });

    // Execute sync asynchronously without blocking webhook HTTP acknowledgment
    setImmediate(() => {
      void (async () => {
        try {
          await executeSync({
            userId: localUserId,
            provider: 'google_health',
            startDate: syncStart,
            endDate: syncEnd,
            metricTypes: [resolvedMetricType],
            trigger: 'webhook',
          });
        } catch (syncErr: unknown) {
          logger.error('Webhook-triggered sync execution failed in background', {
            operation: 'googleWebhookHandler:backgroundSync',
            userId: localUserId,
            metricType: resolvedMetricType,
            error: syncErr instanceof Error ? syncErr.message : String(syncErr),
          });
        }
      })();
    });

    return res.status(200).json({
      status: 'accepted',
      message: 'Google Health webhook notification accepted for asynchronous processing',
      metricType: resolvedMetricType,
      userId: localUserId,
    });
  })
);
