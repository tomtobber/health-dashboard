import { db as defaultDb } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptToken } from './cryptoService';
import { DatabaseError } from '../errors/AppError';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema';

export async function upsertConnectedAccount(
  userId: string,
  provider: string,
  accessToken: string,
  refreshToken: string,
  scopes: string[],
  healthUserIdOrDb?: string | NodePgDatabase<typeof schema>,
  dbInstanceOrHook?: NodePgDatabase<typeof schema> | ((tx: unknown) => Promise<void> | void),
  onBeforeCommitHook?: (tx: unknown) => Promise<void> | void
): Promise<void> {
  let healthUserId: string | undefined;
  let dbInstance: NodePgDatabase<typeof schema> = defaultDb;
  let onBeforeCommit: ((tx: unknown) => Promise<void> | void) | undefined;

  if (typeof healthUserIdOrDb === 'string') {
    healthUserId = healthUserIdOrDb;
    if (dbInstanceOrHook && typeof dbInstanceOrHook === 'object') {
      dbInstance = dbInstanceOrHook as NodePgDatabase<typeof schema>;
    }
    if (typeof onBeforeCommitHook === 'function') {
      onBeforeCommit = onBeforeCommitHook;
    }
  } else if (healthUserIdOrDb && typeof healthUserIdOrDb === 'object') {
    dbInstance = healthUserIdOrDb as NodePgDatabase<typeof schema>;
    if (typeof dbInstanceOrHook === 'function') {
      onBeforeCommit = dbInstanceOrHook as (tx: unknown) => Promise<void> | void;
    }
  }

  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = encryptToken(refreshToken);

  try {
    await dbInstance.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)));

      if (existing.length > 0) {
        await tx
          .update(connectedAccounts)
          .set({
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
            scopes: JSON.stringify(scopes),
            healthUserId: healthUserId || existing[0].healthUserId,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, existing[0].id));
      } else {
        await tx.insert(connectedAccounts).values({
          userId,
          provider,
          healthUserId,
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
  } catch (dbErr: unknown) {
    if (dbErr instanceof DatabaseError) throw dbErr;
    throw new DatabaseError(
      'Failed to persist connected account in database transaction',
      {
        operation: 'upsertConnectedAccount',
        userId,
        provider,
        healthUserId,
      },
      dbErr
    );
  }
}
