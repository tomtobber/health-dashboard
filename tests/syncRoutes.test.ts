import request from 'supertest';
import { app } from '../src/app';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { encryptToken } from '../src/services/cryptoService';
import { eq } from 'drizzle-orm';

describe('Sync Routes', () => {
  let authToken: string;
  let testUserId: string;
  const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

  beforeAll(async () => {
    if (isNeonDb) {
      // Clean up if exists
      await pool.query('DELETE FROM users WHERE email = $1', ['sync_routes_test@example.com']);

      const [user] = await db
        .insert(users)
        .values({
          email: 'sync_routes_test@example.com',
          passwordHash: 'sync_routes_hash_123',
        })
        .returning();

      testUserId = user.id;

      await db.insert(connectedAccounts).values({
        userId: testUserId,
        provider: 'google_health',
        accessToken: encryptToken('mock_access_token_sync_route'),
        refreshToken: encryptToken('mock_refresh_token_sync_route'),
        scopes: '[]',
        status: 'active',
      });
    } else {
      testUserId = 'a0000000-0000-0000-0000-000000000001';
    }

    authToken = jwt.sign({ id: testUserId, email: 'sync_routes_test@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (isNeonDb && testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  test('POST /api/sync/scheduled fails with 401 when CRON_SECRET is missing or invalid', async () => {
    const resNoSecret = await request(app).post('/api/sync/scheduled');
    expect(resNoSecret.status).toBe(401);
    expect(resNoSecret.body.code).toBe('AUTHENTICATION_ERROR');

    const resWrongSecret = await request(app)
      .post('/api/sync/scheduled')
      .set('Authorization', 'Bearer invalid-wrong-secret-value');
    expect(resWrongSecret.status).toBe(401);
  });

  test('POST /api/sync/scheduled succeeds with 200 when valid CRON_SECRET is provided', async () => {
    const res = await request(app)
      .post('/api/sync/scheduled')
      .set('Authorization', `Bearer ${env.CRON_SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('summary');
  });

  test('POST /api/sync/trigger executes manual sync and returns results', async () => {
    const res = await request(app)
      .post('/api/sync/trigger')
      .set('Authorization', 'Bearer ' + authToken)
      .send({
        metricTypes: ['steps', 'heart_rate'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('syncRunId');
    expect(res.body).toHaveProperty('status', 'completed');
    expect(res.body).toHaveProperty('pointsFetched');
  });

  test('GET /api/sync/status retrieves backfill status and sync runs', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', 'Bearer ' + authToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('backfillStatus');
    expect(res.body).toHaveProperty('syncRuns');
  });

  test('GET /api/sync/backfill/status retrieves specific backfill progress', async () => {
    const res = await request(app)
      .get('/api/sync/backfill/status')
      .set('Authorization', 'Bearer ' + authToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('userId', testUserId);
    expect(res.body).toHaveProperty('status');
  });

  test('GET /api/sync/metrics returns canonical metrics for timeframe', async () => {
    const res = await request(app)
      .get('/api/sync/metrics?metricType=heart_rate&startDate=2026-08-01T00:00:00Z&endDate=2026-08-05T00:00:00Z')
      .set('Authorization', 'Bearer ' + authToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metricType', 'heart_rate');
    expect(res.body).toHaveProperty('entries');
  });
});
