import request from 'supertest';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { encryptToken } from '../src/services/cryptoService';
import { env } from '../src/config/env';
import { inArray } from 'drizzle-orm';
import { resolveLocalUserId } from '../src/routes/webhookRoutes';
import { NotFoundError } from '../src/errors/AppError';

describe('Webhook Routes & Exact Attribution (Official Google Health API Spec)', () => {
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    // Clean up previous test users if exist
    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'webhook_user_a@example.com',
      'webhook_user_b@example.com',
    ]).catch(() => {});

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
  });

  afterAll(async () => {
    if (userAId && userBId) {
      await db.delete(users).where(inArray(users.id, [userAId, userBId])).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  test('POST verification probe with valid Authorization header responds 200 OK', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        type: 'verification',
      });

    expect(res.status).toBe(200);
  });

  test('POST verification probe WITHOUT Authorization header fails with 401 Unauthorized', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .send({
        type: 'verification',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST notification fails with 401 when Authorization header is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .send({
        data: [
          {
            healthUserId: 'google_health_user_A_1001',
            dataType: 'steps',
          },
        ],
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('POST notification fails with 401 when Authorization token is invalid', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', 'Bearer invalid_token_123')
      .send({
        data: [
          {
            healthUserId: 'google_health_user_A_1001',
            dataType: 'steps',
          },
        ],
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  test('TWO ACTIVE ACCOUNTS: Notification for User A in nested data array responds 204 and resolves strictly to User A', async () => {
    const resolved = await resolveLocalUserId(undefined, 'google_health_user_A_1001');
    expect(resolved).toBe(userAId);
    expect(resolved).not.toBe(userBId);

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        data: [
          {
            healthUserId: 'google_health_user_A_1001',
            dataType: 'steps',
            operation: 'UPSERT',
            intervals: [
              {
                physicalTimeInterval: {
                  startTime: '2026-08-15T00:00:00Z',
                  endTime: '2026-08-15T01:00:00Z',
                },
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(204);
  });

  test('TWO ACTIVE ACCOUNTS: Notification for User B responds 204 and resolves strictly to User B', async () => {
    const resolved = await resolveLocalUserId(undefined, 'google_health_user_B_2002');
    expect(resolved).toBe(userBId);
    expect(resolved).not.toBe(userAId);

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        data: [
          {
            healthUserId: 'google_health_user_B_2002',
            dataType: 'heartRate',
            operation: 'UPSERT',
            intervals: [
              {
                physicalTimeInterval: {
                  startTime: '2026-08-15T00:00:00Z',
                  endTime: '2026-08-15T01:00:00Z',
                },
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(204);
  });

  test('TWO ACTIVE ACCOUNTS: Notification with UNKNOWN healthUserId is DISCARDED (fails with 404 NotFoundError)', async () => {
    await expect(resolveLocalUserId(undefined, 'unknown_unregistered_google_id_9999')).rejects.toThrow(NotFoundError);

    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        data: [
          {
            healthUserId: 'unknown_unregistered_google_id_9999',
            dataType: 'steps',
          },
        ],
      });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND_ERROR');
    expect(res.body.error).toContain('Unattributable webhook notification');
  });

  test('GUARD CHECK: resolveLocalUserId throws NotFoundError immediately when healthUserId is absent/whitespace', async () => {
    await expect(resolveLocalUserId(undefined, undefined)).rejects.toThrow(NotFoundError);
    await expect(resolveLocalUserId('   ', '')).rejects.toThrow(NotFoundError);
  });

  test('POST /api/webhooks/google returns 400 Bad Request on invalid payload structure', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send({
        data: [],
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('BATCH NOTIFICATIONS: Root-level array batch payload responds 204 and processes correctly', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .set('Authorization', `Bearer ${env.WEBHOOK_AUTH_TOKEN}`)
      .send([
        {
          data: {
            healthUserId: 'google_health_user_A_1001',
            dataType: 'steps',
            operation: 'UPSERT',
            intervals: [
              {
                physicalTimeInterval: {
                  startTime: '2026-08-17T12:00:00Z',
                  endTime: '2026-08-17T12:05:00Z',
                },
              },
            ],
          },
        },
        {
          data: {
            healthUserId: 'google_health_user_B_2002',
            dataType: 'heart-rate',
            operation: 'UPSERT',
            intervals: [
              {
                physicalTimeInterval: {
                  startTime: '2026-08-17T12:00:00Z',
                  endTime: '2026-08-17T12:05:00Z',
                },
              },
            ],
          },
        },
      ]);

    expect(res.status).toBe(204);
  });
});
