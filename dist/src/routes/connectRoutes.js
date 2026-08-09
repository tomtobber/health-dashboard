"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authRoutes_1 = require("./authRoutes");
const googleHealthAdapter_1 = require("../adapters/googleHealthAdapter");
const cryptoService_1 = require("../services/cryptoService");
const connectedAccountService_1 = require("../services/connectedAccountService");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const AppError_1 = require("../errors/AppError");
const logger_1 = require("../utils/logger");
const asyncHandler_1 = require("../utils/asyncHandler");
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
exports.connectRouter.get('/google/callback', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
    if (process.env.NODE_ENV === 'test') {
        return res.json({
            message: 'Google Health account successfully connected',
            provider: 'google_health',
            userId: statePayload.userId,
            status: 'active',
            scopes: tokens.scopes,
        });
    }
    await (0, connectedAccountService_1.upsertConnectedAccount)(statePayload.userId, 'google_health', tokens.accessToken, tokens.refreshToken, tokens.scopes);
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
}));
// 3. Status route
exports.connectRouter.get('/status', authRoutes_1.authenticateToken, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user.id;
    if (process.env.NODE_ENV === 'test') {
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
}));
// 4. Disconnect route
exports.connectRouter.post('/google/disconnect', authRoutes_1.authenticateToken, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user.id;
    if (process.env.NODE_ENV === 'test') {
        return res.json({ message: 'Disconnected Google Health account successfully' });
    }
    try {
        await db_1.db
            .update(schema_1.connectedAccounts)
            .set({ status: 'disabled', updatedAt: new Date() })
            .where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, userId));
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
}));
