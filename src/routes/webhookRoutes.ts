import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { executeSync } from '../services/syncService';
import { logger } from '../utils/logger';
import { AuthenticationError, ValidationError } from '../errors/AppError';
import { safeTimingCompare } from '../services/cryptoService';
import { env } from '../config/env';

export const webhookRouter = Router();

const webhookPayloadSchema = z.object({
  userId: z.string({ required_error: 'userId is required in webhook payload' }),
  metricType: z.string({ required_error: 'metricType is required in webhook payload' }),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
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

    const { userId, metricType, startDate, endDate } = parseResult.data;
    const now = new Date();
    const syncStart = startDate ? new Date(startDate) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const syncEnd = endDate ? new Date(endDate) : now;

    logger.info('Received Google Health webhook notification', {
      operation: 'googleWebhookHandler',
      userId,
      metricType,
    });

    // Trigger async sync non-blockingly with proper promise handling
    setImmediate(() => {
      void (async () => {
        try {
          await executeSync({
            userId,
            startDate: syncStart,
            endDate: syncEnd,
            metricTypes: [metricType],
            trigger: 'webhook',
          });
        } catch (err: unknown) {
          logger.error('Webhook-triggered async sync failed', {
            operation: 'googleWebhookHandler:asyncSync',
            userId,
            metricType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });

    return res.status(200).json({ status: 'accepted', message: 'Webhook notification queued for processing' });
  })
);
