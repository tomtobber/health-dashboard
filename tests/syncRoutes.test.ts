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

  beforeAll(async () => {
    // Clean up if exists
    await pool.query('DELETE FROM users WHERE email = $1', ['sync_routes_test@example.com']).catch(() => {});

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

    authToken = jwt.sign({ id: testUserId, email: 'sync_routes_test@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  test('POST /api/sync/scheduled fails with 401 when CRON_SECRET is missing', async () => {
    const res = await request(app)
      .post('/api/sync/scheduled')
      .send();

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST /api/sync/scheduled fails with 401 when CRON_SECRET is invalid', async () => {
    const res = await request(app)
      .post('/api/sync/scheduled')
      .set('Authorization', 'Bearer wrong_cron_secret')
      .send();

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST /api/sync/scheduled succeeds with valid CRON_SECRET and evaluates due syncs', async () => {

    const res = await request(app)
      .post('/api/sync/scheduled')
      .set('Authorization', `Bearer ${env.CRON_SECRET}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('summary');
  });

  test('POST /api/sync/trigger executes on-demand manual sync for authenticated user', async () => {
    const res = await request(app)
      .post('/api/sync/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        provider: 'google_health',
        metricTypes: ['heart_rate'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'completed');
    expect(res.body).toHaveProperty('syncRunId');
  });

  test('GET /api/sync/status returns sync status and history', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('syncRuns');
    expect(res.body).toHaveProperty('backfillStatus');
  });

  test('GET /api/sync/metrics queries canonical metrics for user', async () => {
    const res = await request(app)
      .get('/api/sync/metrics?metricType=heart_rate&startDate=2026-08-01T00:00:00Z&endDate=2026-08-15T00:00:00Z')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metricType', 'heart_rate');
    expect(res.body).toHaveProperty('entries');
  });
});
