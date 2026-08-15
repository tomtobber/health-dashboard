import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema';
import { users, connectedAccounts } from '../src/db/schema';
import { upsertConnectedAccount } from '../src/services/connectedAccountService';
import { DatabaseError } from '../src/errors/AppError';
import { GoogleHealthAdapter } from '../src/adapters/googleHealthAdapter';
import { eq, sql } from 'drizzle-orm';

describe('upsertConnectedAccount Real PostgreSQL Transaction & Rollback Integration Tests', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let testDb: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('test_db')
      .withUsername('test_user')
      .withPassword('test_pass')
      .start();

    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    testDb = drizzle(pool, { schema });

    await testDb.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS connected_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        health_user_id TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }, 60000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  test('INSERT branch: Real PostgreSQL constraint violation forces transaction rollback, leaving 0 records', async () => {
    const [testUser] = await testDb
      .insert(users)
      .values({ email: 'tx-insert-user@example.com', passwordHash: 'hash123' })
      .returning();

    const failingInsertPromise = upsertConnectedAccount(
      testUser.id,
      'google_health',
      'access_token_1',
      'refresh_token_1',
      GoogleHealthAdapter.SCOPES,
      testDb,
      async (tx: unknown) => {
        const dbTx = tx as NodePgDatabase<typeof schema>;
        await dbTx.execute(sql`
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
      }
    );

    await expect(failingInsertPromise).rejects.toThrow(DatabaseError);

    const dbAccounts = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(dbAccounts).toHaveLength(0);
  });

  test('UPDATE branch: Real PostgreSQL constraint violation forces transaction rollback, preserving original tokens', async () => {
    const [testUser] = await testDb
      .insert(users)
      .values({ email: 'tx-update-user@example.com', passwordHash: 'hash123' })
      .returning();

    await upsertConnectedAccount(
      testUser.id,
      'google_health',
      'original_access_token',
      'original_refresh_token',
      GoogleHealthAdapter.SCOPES,
      testDb
    );

    const initialAccounts = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(initialAccounts).toHaveLength(1);
    const originalAccessToken = initialAccounts[0].accessToken;

    const failingUpdatePromise = upsertConnectedAccount(
      testUser.id,
      'google_health',
      'new_uncommitted_access_token',
      'new_uncommitted_refresh_token',
      GoogleHealthAdapter.SCOPES,
      testDb,
      async (tx: unknown) => {
        const dbTx = tx as NodePgDatabase<typeof schema>;
        await dbTx.execute(sql`
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
      }
    );

    await expect(failingUpdatePromise).rejects.toThrow(DatabaseError);

    const remainingAccounts = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(remainingAccounts).toHaveLength(1);
    expect(remainingAccounts[0].accessToken).toBe(originalAccessToken);
  });
});
