import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { users, connectedAccounts, metricEntries } from '../src/db/schema';
import { executeSync } from '../src/services/syncService';
import { encryptToken } from '../src/services/cryptoService';
import { pool as defaultPool } from '../src/db';
import * as dotenv from 'dotenv';

dotenv.config();

const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

(isNeonDb ? describe : describe.skip)('Reconciliation Sweep Soft-Delete Integration Tests', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let testUserId: string;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    expect(connectionString).toBeDefined();

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });

    db = drizzle(pool, { schema });

    // Clean up test user if exists
    await pool.query('DELETE FROM users WHERE email = $1', ['reconciliation-test@example.com']);

    // Create test user
    const [createdUser] = await db
      .insert(users)
      .values({
        email: 'reconciliation-test@example.com',
        passwordHash: 'hashed_password_for_reconciliation_test',
      })
      .returning();

    testUserId = createdUser.id;

    // Create connected account
    await db.insert(connectedAccounts).values({
      userId: testUserId,
      provider: 'google_health',
      accessToken: encryptToken('mock_access_token_reconcile'),
      refreshToken: encryptToken('mock_refresh_token_reconcile'),
      scopes: '[]',
      status: 'active',
    });
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

  test('Reconciliation sweep marks missing points with deleted_at (soft delete)', async () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Insert an old raw point that is no longer returned by the mock Google Health adapter
    const [oldPoint] = await db
      .insert(metricEntries)
      .values({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: 'ext_old_obsolete_step_999',
        startTime: oneDayAgo,
        endTime: now,
        valueNumeric: 2500,
        unit: 'count',
        sourceStream: 'raw',
        aggregation: 'raw',
      })
      .returning();

    expect(oldPoint.deletedAt).toBeNull();

    // Execute reconciliation sync
    await executeSync({
      userId: testUserId,
      startDate: oneDayAgo,
      endDate: now,
      metricTypes: ['steps'],
      trigger: 'reconciliation',
    });

    // Verify that the obsolete point now has deletedAt set (soft-deleted)
    const [updatedPoint] = await db
      .select()
      .from(metricEntries)
      .where(and(eq(metricEntries.userId, testUserId), eq(metricEntries.id, oldPoint.id)));

    expect(updatedPoint).toBeDefined();
    expect(updatedPoint.deletedAt).not.toBeNull();
  });
});
