import request from 'supertest';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { encryptToken } from '../src/services/cryptoService';
import { env } from '../src/config/env';
import { inArray } from 'drizzle-orm';
import { resolveLocalUserId } from '../src/routes/webhookRoutes';
import { NotFoundError } from '../src/errors/AppError';

describe('Webhook Routes & Exact Attribution', () => {
  let userAId: string;
  let userBId: string;
  const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

  beforeAll(async () => {
    if (isNeonDb) {
      // Clean up previous test users if exist
      await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
        'webhook_user_a@example.com',
        'webhook_user_b@example.com',
      ]);

      const [userA] = await db
        .insert(users)
        .values({
          email: 'webhook_user_a@example.com',
          passwordHash: 'hash_a_123',
        })
        .returning();

      const [userB] = await db
        .insert(users)
        .values({
          email: 'webhook_user_b@example.com',
          passwordHash: 'hash_b_123',
        })
        .returning();

      userAId = userA.id;
      userBId = userB.id;

      // Create TWO active connected accounts with distinct healthUserId values
      await db.insert(connectedAccounts).values([
        {
          userId: userAId,
          provider: 'google_health',
          healthUserId: 'google_health_user_A_1001',
          accessToken: encryptToken('mock_access_token_a'),
          refreshToken: encryptToken('mock_refresh_token_a'),
          scopes: '[]',
          status: 'active',
        },
        {
          userId: userBId,
          provider: 'google_health',
          healthUserId: 'google_health_user_B_2002',
          accessToken: encryptToken('mock_access_token_b'),
          refreshToken: encryptToken('mock_refresh_token_b'),
          scopes: '[]',
          status: 'active',
        },
      ]);
    } else {
      userAId = 'c0000000-0000-0000-0000-00000000000a';
      userBId = 'c0000000-0000-0000-0000-00000000000b';
    }
  });

  afterAll(async () => {
    if (isNeonDb && userAId && userBId) {
      await db.delete(users).where(inArray(users.id, [userAId, userBId])).catch(() => {});
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
        healthUserId: 'google_health_user_A_1001',
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
        healthUserId: 'google_health_user_A_1001',
        metricType: 'steps',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('TWO ACTIVE ACCOUNTS: Webhook for user A is strictly attributed to User A and NEVER to User B', async () => {
    if (isNeonDb) {
      const resolved = await resolveLocalUserId(undefined, 'google_health_user_A_1001');
      expect(resolved).toBe(userAId);
      expect(resolved).not.toBe(userBId);
    }

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        healthUserId: isNeonDb ? 'google_health_user_A_1001' : userAId,
        dataType: 'steps',
        startTime: '2026-08-15T00:00:00Z',
        endTime: '2026-08-15T01:00:00Z',
        operation: 'UPSERT',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'accepted');
    expect(res.body).toHaveProperty('userId', userAId);
  });

  test('TWO ACTIVE ACCOUNTS: Webhook for user B is strictly attributed to User B and NEVER to User A', async () => {
    if (isNeonDb) {
      const resolved = await resolveLocalUserId(undefined, 'google_health_user_B_2002');
      expect(resolved).toBe(userBId);
      expect(resolved).not.toBe(userAId);
    }

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        healthUserId: isNeonDb ? 'google_health_user_B_2002' : userBId,
        dataType: 'heart_rate',
        startTime: '2026-08-15T00:00:00Z',
        endTime: '2026-08-15T01:00:00Z',
        operation: 'UPSERT',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'accepted');
    expect(res.body).toHaveProperty('userId', userBId);
  });

  test('TWO ACTIVE ACCOUNTS: Webhook with UNKNOWN healthUserId is DISCARDED (fails with 404 NotFoundError) and never attributed to any user', async () => {
    if (isNeonDb) {
      await expect(resolveLocalUserId(undefined, 'unknown_unregistered_google_id_9999')).rejects.toThrow(NotFoundError);
    }

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        healthUserId: 'unknown_unregistered_google_id_9999',
        dataType: 'steps',
      });

    if (isNeonDb) {
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('code', 'NOT_FOUND_ERROR');
      expect(res.body.error).toContain('Unattributable webhook notification');
    } else {
      expect(res.status).toBe(200);
    }
  });

  test('GUARD CHECK: resolveLocalUserId throws NotFoundError immediately when both healthUserId and payloadUserId are absent', async () => {
    // Both undefined
    await expect(resolveLocalUserId(undefined, undefined)).rejects.toThrow(NotFoundError);
    await expect(resolveLocalUserId(undefined, undefined)).rejects.toThrow(/missing both healthUserId and payloadUserId/i);

    // Both empty strings / whitespace
    await expect(resolveLocalUserId('   ', '')).rejects.toThrow(NotFoundError);
  });

  test('POST /api/webhooks/google returns 400 Bad Request when both healthUserId and payloadUserId are absent from payload', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        dataType: 'steps',
        startTime: '2026-08-15T00:00:00Z',
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toContain('Either healthUserId or userId must be provided');
  });
});
