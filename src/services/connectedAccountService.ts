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
  dbInstance: NodePgDatabase<typeof schema> = defaultDb,
  onBeforeCommit?: (tx: unknown) => Promise<void> | void
): Promise<void> {
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
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, existing[0].id));
      } else {
        await tx.insert(connectedAccounts).values({
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
  } catch (dbErr: unknown) {
    if (dbErr instanceof DatabaseError) throw dbErr;
    throw new DatabaseError(
      'Failed to persist connected account in database transaction',
      {
        operation: 'upsertConnectedAccount',
        userId,
        provider,
      },
      dbErr
    );
  }
}
