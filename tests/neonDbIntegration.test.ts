import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { users, connectedAccounts, metricEntries, syncRuns } from '../src/db/schema';
import { upsertConnectedAccount } from '../src/services/connectedAccountService';
import { decryptToken } from '../src/services/cryptoService';
import { DatabaseError } from '../src/errors/AppError';
import { GoogleHealthAdapter } from '../src/adapters/googleHealthAdapter';
import { pool as defaultPool } from '../src/db';
import * as dotenv from 'dotenv';

dotenv.config();

const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

(isNeonDb ? describe : describe.skip)('Neon PostgreSQL Database Integration Tests', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let testUserId: string;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    expect(connectionString).toBeDefined();
    expect(connectionString).toContain('neon.tech');

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });

    db = drizzle(pool, { schema });

    // Clean up any previous test user with this email
    await pool.query('DELETE FROM users WHERE email = $1', ['neon-integration-test@example.com']);

    // Create a fresh test user in Neon DB
    const [createdUser] = await db
      .insert(users)
      .values({
        email: 'neon-integration-test@example.com',
        passwordHash: 'hashed_password_for_neon_test',
      })
      .returning();

    testUserId = createdUser.id;
  }, 30000);

  afterAll(async () => {
    try {
      if (testUserId && pool) {
        await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
      }
    } finally {
      if (pool) {
        await pool.end();
      }
      if (defaultPool) {
        await defaultPool.end().catch(() => {});
      }
    }
  }, 30000);

  test('1. Neon DB Connectivity & Version Check', async () => {
    const res = await pool.query('SELECT current_database() as db_name, version(), now() as server_time');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].db_name).toBe('neondb');
    expect(res.rows[0].version).toMatch(/PostgreSQL/i);
    expect(res.rows[0].server_time).toBeDefined();
  });

  test('2. Table Schema Existence in Neon Database', async () => {
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tableNames = res.rows.map((r: { table_name: string }) => r.table_name);
    
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('connected_accounts');
    expect(tableNames).toContain('metric_entries');
    expect(tableNames).toContain('sync_runs');
  });

  test('3. Connected Accounts Upsert & Token Encryption in Neon DB', async () => {
    const rawAccessToken = 'neon_live_access_token_abc123';
    const rawRefreshToken = 'neon_live_refresh_token_xyz789';

    await upsertConnectedAccount(
      testUserId,
      'google_health',
      rawAccessToken,
      rawRefreshToken,
      GoogleHealthAdapter.SCOPES,
      db
    );

    // Verify fetch directly from Neon DB
    const fetchedAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, testUserId));

    expect(fetchedAccounts).toHaveLength(1);
    const account = fetchedAccounts[0];
    expect(account.userId).toBe(testUserId);
    expect(account.provider).toBe('google_health');
    expect(account.status).toBe('active');

    // Ensure raw tokens are NOT stored in plaintext
    expect(account.accessToken).not.toBe(rawAccessToken);
    expect(account.refreshToken).not.toBe(rawRefreshToken);

    // Verify decryption roundtrip
    const decryptedAccess = decryptToken(account.accessToken);
    const decryptedRefresh = decryptToken(account.refreshToken);
    expect(decryptedAccess).toBe(rawAccessToken);
    expect(decryptedRefresh).toBe(rawRefreshToken);
  });

  test('4. Metric Entries Batch Insertion and Range Querying in Neon DB', async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 7200 * 1000);

    const entries = await db
      .insert(metricEntries)
      .values([
        {
          userId: testUserId,
          provider: 'google_health',
          metricType: 'steps',
          externalId: 'ext_step_001',
          startTime: twoHoursAgo,
          endTime: oneHourAgo,
          valueNumeric: 1450,
          unit: 'count',
          sourceStream: 'raw',
          aggregation: 'raw',
          rawPayload: { source: 'google_fit', raw_count: 1450 },
        },
        {
          userId: testUserId,
          provider: 'google_health',
          metricType: 'heart_rate',
          externalId: 'ext_hr_001',
          startTime: oneHourAgo,
          endTime: now,
          valueNumeric: 72.5,
          unit: 'bpm',
          sourceStream: 'raw',
          aggregation: 'raw',
          rawPayload: { source: 'google_fit', bpm: 72.5 },
        },
      ])
      .returning();

    expect(entries).toHaveLength(2);

    // Query back from Neon DB with range and metric filter
    const queryResults = await db
      .select()
      .from(metricEntries)
      .where(
        and(
          eq(metricEntries.userId, testUserId),
          eq(metricEntries.metricType, 'steps'),
          gte(metricEntries.startTime, twoHoursAgo),
          lte(metricEntries.endTime, now)
        )
      );

    expect(queryResults).toHaveLength(1);
    expect(queryResults[0].metricType).toBe('steps');
    expect(queryResults[0].valueNumeric).toBe(1450);
    expect(queryResults[0].unit).toBe('count');
  });

  test('5. Sync Runs Insertion and Status Update in Neon DB', async () => {
    const [run] = await db
      .insert(syncRuns)
      .values({
        userId: testUserId,
        provider: 'google_health',
        trigger: 'manual',
        status: 'in_progress',
        pointsFetched: 10,
        pagesFetched: 1,
      })
      .returning();

    expect(run).toBeDefined();
    expect(run.status).toBe('in_progress');

    // Update status
    const [updatedRun] = await db
      .update(syncRuns)
      .set({
        status: 'completed',
        pointsUpserted: 10,
        completedAt: new Date(),
      })
      .where(eq(syncRuns.id, run.id))
      .returning();

    expect(updatedRun.status).toBe('completed');
    expect(updatedRun.pointsUpserted).toBe(10);
    expect(updatedRun.completedAt).not.toBeNull();
  });

  test('6. Atomic Transaction Rollback on Neon DB during Constraint Failure', async () => {
    // Attempt an upsert with an injected failing transaction step
    const failingPromise = upsertConnectedAccount(
      testUserId,
      'google_health',
      'rollback_token_a',
      'rollback_token_b',
      GoogleHealthAdapter.SCOPES,
      db,
      async (tx: unknown) => {
        const dbTx = tx as NodePgDatabase<typeof schema>;
        // Deliberately cause a foreign key violation to test transaction rollback
        await dbTx.execute(sql`
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk', 'token_a', 'token_b', '[]')
        `);
      }
    );

    await expect(failingPromise).rejects.toThrow(DatabaseError);

    // Verify existing connected account was NOT overwritten on Neon DB
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, testUserId));

    expect(accounts).toHaveLength(1);
    const decrypted = decryptToken(accounts[0].accessToken);
    expect(decrypted).toBe('neon_live_access_token_abc123');
  });

  test('7. Foreign Key Cascade Deletion on Neon DB', async () => {
    // Create a temporary user with a connected account and metric
    const [tempUser] = await db
      .insert(users)
      .values({ email: 'cascade-test@example.com', passwordHash: 'hash_cascade' })
      .returning();

    await db.insert(connectedAccounts).values({
      userId: tempUser.id,
      provider: 'google_health',
      accessToken: 'enc_temp_token',
      refreshToken: 'enc_temp_refresh',
      scopes: '[]',
    });

    await db.insert(metricEntries).values({
      userId: tempUser.id,
      provider: 'google_health',
      metricType: 'steps',
      startTime: new Date(),
      endTime: new Date(),
      valueNumeric: 100,
      unit: 'count',
      sourceStream: 'raw',
    });

    // Delete the user from Neon DB
    await db.delete(users).where(eq(users.id, tempUser.id));

    // Verify cascaded deletion
    const remainingAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, tempUser.id));
    expect(remainingAccounts).toHaveLength(0);

    const remainingMetrics = await db
      .select()
      .from(metricEntries)
      .where(eq(metricEntries.userId, tempUser.id));
    expect(remainingMetrics).toHaveLength(0);
  });
});
