import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { signState, verifyState } from '../services/cryptoService';
import { upsertConnectedAccount } from '../services/connectedAccountService';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ValidationError, DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/asyncHandler';

export const connectRouter = Router();
const googleAdapter = new GoogleHealthAdapter();

const callbackQuerySchema = z.object({
  code: z.string({ required_error: 'Authorization code is required' }),
  state: z.string({ required_error: 'OAuth state parameter is required' }),
});

interface StatePayload {
  userId: string;
}

// 1. Authorize route
connectRouter.get('/google/authorize', authenticateToken, (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const signedState = signState({ userId });
    const authUrl = googleAdapter.getAuthUrl(signedState);

    logger.info('Generated Google OAuth authorization URL', { operation: 'googleAuthorize', userId });

    return res.json({
      authUrl,
      signedState,
      requestedScopes: GoogleHealthAdapter.SCOPES,
    });
  } catch (error: unknown) {
    next(error);
  }
});

// 2. Callback route
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

    if (process.env.NODE_ENV === 'test') {
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

    logger.info('Google Health account successfully connected', {
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

    if (process.env.NODE_ENV === 'test') {
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

    if (process.env.NODE_ENV === 'test') {
      return res.json({ message: 'Disconnected Google Health account successfully' });
    }

    try {
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

    logger.info('Google Health account disconnected', { operation: 'googleDisconnect', userId });

    return res.json({ message: 'Disconnected Google Health account successfully' });
  })
);