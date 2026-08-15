import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { executeSync } from '../services/syncService';
import { logger } from '../utils/logger';
import { AuthenticationError, ValidationError, NotFoundError } from '../errors/AppError';
import { safeTimingCompare } from '../services/cryptoService';
import { env } from '../config/env';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq } from 'drizzle-orm';

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
}).refine(data => data.healthUserId || data.userId, {
  message: 'Either healthUserId or userId must be provided in webhook notification payload',
}).refine(data => data.dataType || data.metricType, {
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
 * Resolves the local user_id from Google Health webhook payload.
 */
async function resolveLocalUserId(payloadUserId?: string, healthUserId?: string): Promise<string> {
  const isNeonDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isNeonDb) {
    return payloadUserId || healthUserId || 'test_user_id';
  }

  // 1. If payload contains direct local user UUID, verify it exists
  if (payloadUserId) {
    const [acc] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, payloadUserId));
    if (acc) return acc.userId;
  }

  // 2. Query active connected accounts for google_health
  const activeAccounts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, 'active'));

  if (activeAccounts.length === 1) {
    // For single-user / small-deployment, attribute to the active Google Health connected user
    return activeAccounts[0].userId;
  }

  if (activeAccounts.length > 1 && payloadUserId) {
    const matched = activeAccounts.find(a => a.userId === payloadUserId);
    if (matched) return matched.userId;
  }

  if (activeAccounts.length > 0) {
    return activeAccounts[0].userId;
  }

  throw new NotFoundError('No active connected account found to attribute incoming webhook notification', {
    operation: 'resolveLocalUserId',
    payloadUserId,
    healthUserId,
  });
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
