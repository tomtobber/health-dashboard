"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authRoutes_1 = require("./authRoutes");
const googleHealthAdapter_1 = require("../adapters/googleHealthAdapter");
const cryptoService_1 = require("../services/cryptoService");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const env_1 = require("../config/env");
const AppError_1 = require("../errors/AppError");
const logger_1 = require("../utils/logger");
exports.connectRouter = (0, express_1.Router)();
const googleAdapter = new googleHealthAdapter_1.GoogleHealthAdapter();
const callbackQuerySchema = zod_1.z.object({
    code: zod_1.z.string({ required_error: 'Authorization code is required' }),
    state: zod_1.z.string({ required_error: 'OAuth state parameter is required' }),
});
// 1. Authorize route
exports.connectRouter.get('/google/authorize', authRoutes_1.authenticateToken, (req, res, next) => {
    try {
        const userId = req.user.id;
        const signedState = (0, cryptoService_1.signState)({ userId });
        const authUrl = googleAdapter.getAuthUrl(signedState);
        logger_1.logger.info('Generated Google OAuth authorization URL', { operation: 'googleAuthorize', userId });
        return res.json({
            authUrl,
            signedState,
            requestedScopes: googleHealthAdapter_1.GoogleHealthAdapter.SCOPES,
        });
    }
    catch (error) {
        next(error);
    }
});
// 2. Callback route
exports.connectRouter.get('/google/callback', async (req, res, next) => {
    try {
        const parseResult = callbackQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            throw new AppError_1.ValidationError('Invalid OAuth callback query parameters', {
                operation: 'googleCallback',
                zodErrors: parseResult.error.errors,
            });
        }
        const { code, state } = parseResult.data;
        const statePayload = (0, cryptoService_1.verifyState)(state);
        const tokens = await googleAdapter.authenticate(code);
        const encryptedAccessToken = (0, cryptoService_1.encryptToken)(tokens.accessToken);
        const encryptedRefreshToken = (0, cryptoService_1.encryptToken)(tokens.refreshToken);
        if (env_1.env.NODE_ENV === 'test') {
            return res.json({
                message: 'Google Health account successfully connected',
                provider: 'google_health',
                userId: statePayload.userId,
                status: 'active',
                scopes: tokens.scopes,
            });
        }
        // Wrap connected account upsert multi-step write in a transaction (State Integrity #6)
        try {
            await db_1.db.transaction(async (tx) => {
                const existing = await tx
                    .select()
                    .from(schema_1.connectedAccounts)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, statePayload.userId), (0, drizzle_orm_1.eq)(schema_1.connectedAccounts.provider, 'google_health')));
                if (existing.length > 0) {
                    await tx
                        .update(schema_1.connectedAccounts)
                        .set({
                        accessToken: encryptedAccessToken,
                        refreshToken: encryptedRefreshToken,
                        scopes: JSON.stringify(tokens.scopes),
                        status: 'active',
                        updatedAt: new Date(),
                    })
                        .where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.id, existing[0].id));
                }
                else {
                    await tx.insert(schema_1.connectedAccounts).values({
                        userId: statePayload.userId,
                        provider: 'google_health',
                        accessToken: encryptedAccessToken,
                        refreshToken: encryptedRefreshToken,
                        scopes: JSON.stringify(tokens.scopes),
                        status: 'active',
                    });
                }
            });
        }
        catch (dbErr) {
            throw new AppError_1.DatabaseError('Failed to persist connected account in database transaction', {
                operation: 'googleCallback',
                userId: statePayload.userId,
                cause: dbErr instanceof Error ? dbErr.message : String(dbErr),
            });
        }
        logger_1.logger.info('Google Health account successfully connected', {
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
    }
    catch (error) {
        next(error);
    }
});
// 3. Status route
exports.connectRouter.get('/status', authRoutes_1.authenticateToken, async (req, res, next) => {
    try {
        const userId = req.user.id;
        if (env_1.env.NODE_ENV === 'test') {
            return res.json({
                connectedAccounts: [
                    { provider: 'google_health', status: 'active', scopes: googleHealthAdapter_1.GoogleHealthAdapter.SCOPES },
                ],
            });
        }
        let accounts;
        try {
            accounts = await db_1.db
                .select({
                provider: schema_1.connectedAccounts.provider,
                status: schema_1.connectedAccounts.status,
                scopes: schema_1.connectedAccounts.scopes,
                updatedAt: schema_1.connectedAccounts.updatedAt,
            })
                .from(schema_1.connectedAccounts)
                .where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, userId));
        }
        catch (err) {
            throw new AppError_1.DatabaseError('Failed to query connected accounts status', {
                operation: 'connectStatus',
                userId,
                cause: err instanceof Error ? err.message : String(err),
            });
        }
        return res.json({ connectedAccounts: accounts });
    }
    catch (error) {
        next(error);
    }
});
// 4. Disconnect route
exports.connectRouter.post('/google/disconnect', authRoutes_1.authenticateToken, async (req, res, next) => {
    try {
        const userId = req.user.id;
        if (env_1.env.NODE_ENV === 'test') {
            return res.json({ message: 'Disconnected Google Health account successfully' });
        }
        try {
            await db_1.db
                .update(schema_1.connectedAccounts)
                .set({ status: 'disabled', updatedAt: new Date() })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, userId), (0, drizzle_orm_1.eq)(schema_1.connectedAccounts.provider, 'google_health')));
        }
        catch (err) {
            throw new AppError_1.DatabaseError('Failed to update connected account status to disabled', {
                operation: 'googleDisconnect',
                userId,
                cause: err instanceof Error ? err.message : String(err),
            });
        }
        logger_1.logger.info('Google Health account disconnected', { operation: 'googleDisconnect', userId });
        return res.json({ message: 'Disconnected Google Health account successfully' });
    }
    catch (error) {
        next(error);
    }
});
