import request from 'supertest';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { encryptToken } from '../src/services/cryptoService';
import { env } from '../src/config/env';
import { eq } from 'drizzle-orm';

describe('Webhook Routes', () => {
  let testUserId: string;
  const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

  beforeAll(async () => {
    if (isNeonDb) {
      // Clean up if exists
      await pool.query('DELETE FROM users WHERE email = $1', ['webhook_test@example.com']);

      const [user] = await db
        .insert(users)
        .values({
          email: 'webhook_test@example.com',
          passwordHash: 'webhook_hash_123',
        })
        .returning();

      testUserId = user.id;

      await db.insert(connectedAccounts).values({
        userId: testUserId,
        provider: 'google_health',
        accessToken: encryptToken('mock_access_token_webhook'),
        refreshToken: encryptToken('mock_refresh_token_webhook'),
        scopes: '[]',
        status: 'active',
      });
    } else {
      testUserId = 'c0000000-0000-0000-0000-000000000003';
    }
  });

  afterAll(async () => {
    if (isNeonDb && testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  test('GET /api/webhooks/google responds to verification challenge parameter', async () => {
    const res = await request(app)
      .get('/api/webhooks/google?hub.challenge=test_challenge_code_123');

    expect(res.status).toBe(200);
    expect(res.text).toBe('test_challenge_code_123');
  });

  test('POST /api/webhooks/google fails with 401 when Authorization header is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .send({
        userId: testUserId,
        metricType: 'steps',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST /api/webhooks/google fails with 401 when Authorization header token is invalid', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', 'Bearer invalid_wrong_token')
      .send({
        userId: testUserId,
        metricType: 'steps',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST /api/webhooks/google accepts valid notification payload with healthUserId and dataType', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        healthUserId: 'google_health_user_123',
        dataType: 'steps',
        startTime: '2026-08-15T00:00:00Z',
        endTime: '2026-08-15T01:00:00Z',
        operation: 'UPSERT',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'accepted');
    expect(res.body).toHaveProperty('metricType', 'steps');
  });

  test('POST /api/webhooks/google accepts valid notification payload with local userId and metricType', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        userId: testUserId,
        metricType: 'heart_rate',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'accepted');
    expect(res.body).toHaveProperty('metricType', 'heart_rate');
  });

  test('POST /api/webhooks/google returns 400 Bad Request on invalid payload missing user or metric identifiers', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        someOtherField: 'value',
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});
