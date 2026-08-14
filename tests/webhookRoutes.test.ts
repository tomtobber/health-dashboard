import request from 'supertest';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { encryptToken } from '../src/services/cryptoService';
import { eq } from 'drizzle-orm';

describe('Webhook Routes', () => {
  let testUserId: string;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    try {
      if (testUserId) {
        await db.delete(users).where(eq(users.id, testUserId));
      }
    } finally {
      await pool.end().catch(() => {});
    }
  });

  test('GET /api/webhooks/google responds to verification challenge parameter', async () => {
    const res = await request(app)
      .get('/api/webhooks/google?hub.challenge=test_challenge_code_123');

    expect(res.status).toBe(200);
    expect(res.text).toBe('test_challenge_code_123');
  });

  test('POST /api/webhooks/google accepts valid notification payload and returns 200 accepted', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .send({
        userId: testUserId,
        metricType: 'steps',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'accepted');
  });

  test('POST /api/webhooks/google returns 400 Bad Request on invalid payload missing required fields', async () => {
    const res = await request(app)
      .post('/api/webhooks/google')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});
