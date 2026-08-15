import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { executeSync } from '../services/syncService';
import { env } from '../config/env';
import { safeTimingCompare } from '../services/cryptoService';
import { AuthenticationError, ValidationError, NotFoundError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export const webhookRouter = Router();

const physicalTimeIntervalSchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});

const intervalSchema = z.object({
  physicalTimeInterval: physicalTimeIntervalSchema.optional(),
});

export const singleNotificationItemSchema = z.object({
  healthUserId: z.string({ required_error: 'healthUserId is required in notification data' }).min(1),
  dataType: z.string({ required_error: 'dataType is required in notification data' }).min(1),
  operation: z.string().optional(),
  intervals: z.array(intervalSchema).optional(),
});

export type NotificationItem = z.infer<typeof singleNotificationItemSchema>;

export const webhookPayloadSchema = z.union([
  z.object({
    type: z.literal('verification'),
  }),
  z.object({
    data: z.union([
      z.array(singleNotificationItemSchema).min(1),
      singleNotificationItemSchema,
    ]),
  }),
]);

/**
 * Authenticates incoming Google Health webhook requests via Bearer token.
 */
function authenticateWebhookRequest(req: Request): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    throw new AuthenticationError('Unauthorized: Missing webhook authorization token', {
      operation: 'authenticateWebhookRequest',
      path: req.path,
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    throw new AuthenticationError('Unauthorized: Invalid authorization format. Expected Bearer token', {
      operation: 'authenticateWebhookRequest',
      path: req.path,
    });
  }

  const token = parts[1].trim();
  if (!safeTimingCompare(token, env.WEBHOOK_AUTH_TOKEN)) {
    throw new AuthenticationError('Unauthorized: Invalid webhook authorization token', {
      operation: 'authenticateWebhookRequest',
      path: req.path,
    });
  }
}

/**
 * Resolves local user ID via strict exact-matching on healthUserId or payloadUserId.
 * Throws NotFoundError immediately if not found (zero guessing or arbitrary fallback).
 */
export async function resolveLocalUserId(
  payloadUserId?: string,
  healthUserId?: string
): Promise<string> {
  const sanitizedHealthUserId = typeof healthUserId === 'string' ? healthUserId.trim() : '';
  const sanitizedPayloadUserId = typeof payloadUserId === 'string' ? payloadUserId.trim() : '';

  if (!sanitizedHealthUserId && !sanitizedPayloadUserId) {
    logger.error('Webhook notification missing both healthUserId and payloadUserId — cannot attribute', {
      operation: 'resolveLocalUserId',
      sanitizedHealthUserId,
      sanitizedPayloadUserId,
    });
    throw new NotFoundError('Unattributable webhook: missing both healthUserId and payloadUserId', {
      operation: 'resolveLocalUserId',
    });
  }

  const queryCondition = sanitizedHealthUserId
    ? eq(connectedAccounts.healthUserId, sanitizedHealthUserId)
    : eq(connectedAccounts.userId, sanitizedPayloadUserId);

  const matchedAccounts = await db
    .select({
      userId: connectedAccounts.userId,
      healthUserId: connectedAccounts.healthUserId,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.status, 'active'),
        eq(connectedAccounts.provider, 'google_health'),
        queryCondition
      )
    )
    .limit(1);

  if (!matchedAccounts || matchedAccounts.length === 0) {
    logger.warn('Unattributable webhook notification discarded: no active connected account matches identifier', {
      operation: 'resolveLocalUserId',
      sanitizedHealthUserId,
      sanitizedPayloadUserId,
    });
    throw new NotFoundError('Unattributable webhook notification: no matching active account found', {
      operation: 'resolveLocalUserId',
      sanitizedHealthUserId,
      sanitizedPayloadUserId,
    });
  }

  return matchedAccounts[0].userId;
}

/**
 * POST /api/webhooks/google
 * 
 * Handles:
 * 1. Subscription verification probes ({"type":"verification"})
 * 2. Real Google Health API webhook notifications ({"data": [...]})
 * 
 * Responds with HTTP 204 No Content immediately, executing synchronization asynchronously.
 */
webhookRouter.post(
  '/google',
  asyncHandler(async (req: Request, res: Response): Promise<unknown> => {
    // 1. Authenticate the request header
    authenticateWebhookRequest(req);

    // 2. Validate payload structure with Zod
    const parseResult = webhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid webhook payload format', {
        operation: 'googleWebhookHandler',
        zodErrors: parseResult.error.errors,
      });
    }

    const payload = parseResult.data;

    // 3. Handle verification probe from Google Health API
    if ('type' in payload) {
      logger.info('Google Health webhook subscription verification probe received and authorized', {
        operation: 'googleWebhookVerificationProbe',
      });
      return res.status(204).end();
    }

    // 4. Handle real notification data payload
    const notificationData = payload.data;
    const items: NotificationItem[] = Array.isArray(notificationData) ? notificationData : [notificationData];

    for (const item of items) {
      // Resolve target user strictly
      const localUserId = await resolveLocalUserId(undefined, item.healthUserId);

      // Extract physical time intervals if present
      const firstInterval = item.intervals?.[0]?.physicalTimeInterval;
      const now = new Date();
      const startDate = firstInterval?.startTime ? new Date(firstInterval.startTime) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const endDate = firstInterval?.endTime ? new Date(firstInterval.endTime) : now;

      logger.info('Received and authenticated Google Health webhook notification', {
        operation: 'googleWebhookHandler',
        localUserId,
        healthUserId: item.healthUserId,
        dataType: item.dataType,
        operationType: item.operation,
        window: { start: startDate.toISOString(), end: endDate.toISOString() },
      });

      // Execute sync asynchronously (do not block 204 webhook response)
      setImmediate(() => {
        void executeSync({
          userId: localUserId,
          startDate,
          endDate,
          metricTypes: [item.dataType.toLowerCase()],
          trigger: 'webhook',
        }).catch((err: unknown) => {
          logger.error('Asynchronous webhook sync execution failed', {
            operation: 'executeSync:webhook:async',
            userId: localUserId,
            healthUserId: item.healthUserId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    }

    // 5. Google Health Webhooks spec requires immediate 204 No Content
    return res.status(204).end();
  })
);
