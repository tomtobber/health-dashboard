"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertConnectedAccount = upsertConnectedAccount;
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const cryptoService_1 = require("./cryptoService");
const AppError_1 = require("../errors/AppError");
async function upsertConnectedAccount(userId, provider, accessToken, refreshToken, scopes, dbInstance = db_1.db, onBeforeCommit) {
    const encryptedAccessToken = (0, cryptoService_1.encryptToken)(accessToken);
    const encryptedRefreshToken = (0, cryptoService_1.encryptToken)(refreshToken);
    try {
        await dbInstance.transaction(async (tx) => {
            const existing = await tx
                .select()
                .from(schema_1.connectedAccounts)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, userId), (0, drizzle_orm_1.eq)(schema_1.connectedAccounts.provider, provider)));
            if (existing.length > 0) {
                await tx
                    .update(schema_1.connectedAccounts)
                    .set({
                    accessToken: encryptedAccessToken,
                    refreshToken: encryptedRefreshToken,
                    scopes: JSON.stringify(scopes),
                    status: 'active',
                    updatedAt: new Date(),
                })
                    .where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.id, existing[0].id));
            }
            else {
                await tx.insert(schema_1.connectedAccounts).values({
                    userId,
                    provider,
                    accessToken: encryptedAccessToken,
                    refreshToken: encryptedRefreshToken,
                    scopes: JSON.stringify(scopes),
                    status: 'active',
                });
            }
            if (onBeforeCommit) {
                await onBeforeCommit(tx);
            }
        });
    }
    catch (dbErr) {
        if (dbErr instanceof AppError_1.DatabaseError)
            throw dbErr;
        throw new AppError_1.DatabaseError('Failed to persist connected account in database transaction', {
            operation: 'upsertConnectedAccount',
            userId,
            provider,
            cause: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
    }
}
