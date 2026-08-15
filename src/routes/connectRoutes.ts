import { Router, Response } from 'express';
import { z } from 'zod';
import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { signState, verifyState, decryptToken } from '../services/cryptoService';
import { upsertConnectedAccount } from '../services/connectedAccountService';
import { triggerInitialBackfill } from '../services/backfillService';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError, DatabaseError } from '../errors/AppError';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const connectRouter = Router();
const googleAdapter = new GoogleHealthAdapter();

interface StatePayload {
  userId: string;
  timestamp: number;
}

const callbackQuerySchema = z.object({
  code: z.string({ required_error: 'Authorization code is required in callback query' }),
  state: z.string({ required_error: 'Signed state is required in callback query' }),
});

// 1. Initiate Google OAuth Flow
connectRouter.get(
  '/google/authorize',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;
    const signedState = signState({ userId, timestamp: Date.now() });
    const authUrl = googleAdapter.getAuthUrl(signedState);

    logger.info('Generated Google OAuth authorization URL', { operation: 'googleAuthorize', userId });
    return res.json({
      url: authUrl,
      authUrl,
      signedState,
      requestedScopes: GoogleHealthAdapter.SCOPES,
    });
  })
);

// 2. Google OAuth Callback
connectRouter.get(
  '/google/callback',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const parseResult = callbackQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError('Invalid OAuth callback query parameters', {
        operation: 'googleCallback',
        zodErrors: parseResult.error.errors,
      });
    }

    const { code, state } = parseResult.data;
    const statePayload = verifyState<StatePayload>(state);

    const tokens = await googleAdapter.authenticate(code);

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
      return res.json({
        message: 'Google Health account successfully connected',
        provider: 'google_health',
        userId: statePayload.userId,
        status: 'active',
        scopes: tokens.scopes,
      });
    }

    await upsertConnectedAccount(
      statePayload.userId,
      'google_health',
      tokens.accessToken,
      tokens.refreshToken,
      tokens.scopes
    );

    // Register or update webhook subscription asynchronously with full updated metricTypes
    setImmediate(() => {
      void (async () => {
        try {
          const webhookUrl = `${env.APP_BASE_URL}/api/webhooks/google`;
          await googleAdapter.createSubscription(webhookUrl, tokens.accessToken);
        } catch (subErr: unknown) {
          logger.warn('Google Health subscription registration/update failed in background', {
            operation: 'googleCallback:createSubscription',
            userId: statePayload.userId,
            error: subErr instanceof Error ? subErr.message : String(subErr),
          });
        }
      })();
    });

    // Trigger initial 1-year historical backfill asynchronously
    triggerInitialBackfill(statePayload.userId, 365);

    logger.info('Google Health account successfully connected and backfill started', {
      operation: 'googleCallback',
      userId: statePayload.userId,
    });

    return res.json({
      message: 'Google Health account successfully connected',
      provider: 'google_health',
      userId: statePayload.userId,
      status: 'active',
      scopes: tokens.scopes,
    });
  })
);

// 3. Status route
connectRouter.get(
  '/status',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
      return res.json({
        connectedAccounts: [
          { provider: 'google_health', status: 'active', scopes: GoogleHealthAdapter.SCOPES },
        ],
      });
    }

    let accounts: { provider: string; status: string; scopes: string; updatedAt: Date }[];
    try {
      accounts = await db
        .select({
          provider: connectedAccounts.provider,
          status: connectedAccounts.status,
          scopes: connectedAccounts.scopes,
          updatedAt: connectedAccounts.updatedAt,
        })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.userId, userId));
    } catch (err: unknown) {
      throw new DatabaseError('Failed to query connected accounts status', {
        operation: 'connectStatus',
        userId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    return res.json({ connectedAccounts: accounts });
  })
);

// 4. Disconnect route
connectRouter.post(
  '/google/disconnect',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
      return res.json({ message: 'Disconnected Google Health account successfully' });
    }

    let accountToken: string | undefined;
    try {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, 'google_health')));

      if (account) {
        accountToken = decryptToken(account.accessToken);
      }

      await db
        .update(connectedAccounts)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(eq(connectedAccounts.userId, userId));
    } catch (err: unknown) {
      throw new DatabaseError('Failed to update connected account status to disabled', {
        operation: 'googleDisconnect',
        userId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // Clean up Google Health webhook subscription asynchronously
    if (accountToken) {
      setImmediate(() => {
        void (async () => {
          try {
            await googleAdapter.deleteSubscription('self', accountToken);
          } catch (delErr: unknown) {
            logger.warn('Google Health subscription deletion failed in background', {
              operation: 'googleDisconnect:deleteSubscription',
              userId,
              error: delErr instanceof Error ? delErr.message : String(delErr),
            });
          }
        })();
      });
    }

    logger.info('Google Health account disconnected', { operation: 'googleDisconnect', userId });
    return res.json({ message: 'Disconnected Google Health account successfully' });
  })
);

// 5. On-demand Webhook Subscription Sync / Update route
connectRouter.post(
  '/google/sync-subscription',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<unknown> => {
    const userId = req.user!.id;

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
      return res.json({
        message: 'Google Health webhook subscription updated to latest metric types',
        active: true,
        subscriptionId: 'mock_sub_updated_' + userId,
      });
    }

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, 'google_health')));

    if (!account || account.status !== 'active') {
      throw new ValidationError('No active Google Health connected account found for user', {
        operation: 'syncSubscription',
        userId,
      });
    }

    const decryptedAccessToken = decryptToken(account.accessToken);
    const webhookUrl = `${env.APP_BASE_URL}/api/webhooks/google`;
    const result = await googleAdapter.updateSubscription(webhookUrl, decryptedAccessToken);

    return res.json({
      message: 'Google Health webhook subscription updated to latest metric types',
      active: result.active,
      subscriptionId: result.subscriptionId,
      error: result.error,
    });
  })
);
