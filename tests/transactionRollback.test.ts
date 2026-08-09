import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { users, connectedAccounts } from '../src/db/schema';
import { upsertConnectedAccount } from '../src/services/connectedAccountService';
import { DatabaseError } from '../src/errors/AppError';

jest.setTimeout(120000);

describe('Transaction Rollback Real Postgres Integration Test', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let testDb: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    // 1. Start real PostgreSQL 15 container via testcontainers. NO try/catch silent skipping!
    // If Docker is unavailable, this throws and fails the test suite loudly.
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const connectionString = container.getConnectionUri();

    pool = new Pool({ connectionString });
    testDb = drizzle(pool, { schema });

    // 2. Execute real Drizzle schema creation against PostgreSQL container
    await testDb.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS connected_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE TABLE connected_accounts, users CASCADE;`);
  });

  test('INSERT branch: Real PostgreSQL FK constraint violation forces transaction rollback, persisting 0 rows', async () => {
    // Insert valid user into PostgreSQL
    const [testUser] = await testDb
      .insert(users)
      .values({ email: 'tx-insert-user@example.com', passwordHash: 'hash123' })
      .returning();

    // Force real Postgres FK Constraint Violation (code 23503) inside transaction via onBeforeCommit callback
    const failingInsertPromise = upsertConnectedAccount(
      testUser.id,
      'google_health',
      'access_token_1',
      'refresh_token_1',
      ['activity_and_fitness'],
      testDb,
      async (tx: unknown) => {
        const dbTx = tx as NodePgDatabase<typeof schema>;
        // Attempt inserting connected_account referencing non-existent user_id -> PostgreSQL rejects with FK error 23503
        await dbTx.execute(sql`
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
      }
    );

    await expect(failingInsertPromise).rejects.toThrow(DatabaseError);

    // Direct Real PostgreSQL Query Assertion: Assert 0 connected_accounts records persisted in Postgres
    const dbAccounts = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(dbAccounts).toHaveLength(0);
  });

  test('UPDATE branch: Real PostgreSQL constraint violation forces transaction rollback, preserving original tokens', async () => {
    const [testUser] = await testDb
      .insert(users)
      .values({ email: 'tx-update-user@example.com', passwordHash: 'hash123' })
      .returning();

    // 1. Initial valid insert (commits successfully to real Postgres container)
    await upsertConnectedAccount(
      testUser.id,
      'google_health',
      'original_access_token',
      'original_refresh_token',
      ['activity_and_fitness'],
      testDb
    );

    const initialAccounts = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(initialAccounts).toHaveLength(1);
    const originalAccessToken = initialAccounts[0].accessToken;

    // 2. Attempt update with new tokens, but force real Postgres FK constraint violation before commit
    const failingUpdatePromise = upsertConnectedAccount(
      testUser.id,
      'google_health',
      'new_uncommitted_access_token',
      'new_uncommitted_refresh_token',
      ['activity_and_fitness'],
      testDb,
      async (tx: unknown) => {
        const dbTx = tx as NodePgDatabase<typeof schema>;
        // Attempt invalid FK write inside transaction block -> PostgreSQL aborts transaction block & rolls back
        await dbTx.execute(sql`
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
      }
    );

    await expect(failingUpdatePromise).rejects.toThrow(DatabaseError);

    // 3. Direct Real PostgreSQL Query Assertion: Original record tokens in Postgres remain unchanged
    const accountsAfterFailure = await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, testUser.id));
    expect(accountsAfterFailure).toHaveLength(1);
    expect(accountsAfterFailure[0].accessToken).toEqual(originalAccessToken);
  });
});