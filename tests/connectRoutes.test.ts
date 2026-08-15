import request from 'supertest';
import { app } from '../src/app';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';
import { encryptToken } from '../src/services/cryptoService';
import { GoogleHealthAdapter } from '../src/adapters/googleHealthAdapter';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Connect Routes API (Google OAuth)', () => {
  let authToken: string;
  let testUserId: string;

  beforeAll(async () => {
    // Clean up if exists
    await pool.query('DELETE FROM users WHERE email = $1', ['connect_test@example.com']).catch(() => {});

    const [user] = await db
      .insert(users)
      .values({
        email: 'connect_test@example.com',
        passwordHash: 'connect_hash_123',
      })
      .returning();

    testUserId = user.id;

    await db.insert(connectedAccounts).values({
      userId: testUserId,
      provider: 'google_health',
      accessToken: encryptToken('mock_access_token_connect'),
      refreshToken: encryptToken('mock_refresh_token_connect'),
      scopes: JSON.stringify(GoogleHealthAdapter.SCOPES),
      status: 'active',
    });

    authToken = jwt.sign({ id: testUserId, email: 'connect_test@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  test('GET /api/connect/google/authorize generates signed state and required full scope URIs in authUrl', async () => {
    const res = await request(app)
      .get('/api/connect/google/authorize')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('authUrl');
    expect(res.body.authUrl).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(res.body.authUrl).toContain('https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgooglehealth.activity_and_fitness.readonly');
    expect(res.body.authUrl).toContain('https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgooglehealth.health_metrics_and_measurements.readonly');
    expect(res.body.authUrl).toContain('https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgooglehealth.sleep.readonly');
  });

  test('GET /api/connect/google/callback fails with 400 Bad Request on invalid HMAC state', async () => {
    const res = await request(app)
      .get('/api/connect/google/callback?code=mock_code&state=malformed.tampered_state');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'CRYPTOGRAPHIC_ERROR');
  });

  test('GET /api/connect/google/callback successfully authenticates tokens, upserts account and triggers backfill', async () => {
    const { signState } = await import('../src/services/cryptoService');
    const validState = signState({ userId: testUserId, timestamp: Date.now() });

    const res = await request(app)
      .get(`/api/connect/google/callback?code=test_code_abc&state=${validState}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Google Health account successfully connected');
    expect(res.body).toHaveProperty('provider', 'google_health');
    expect(res.body).toHaveProperty('status', 'active');
  });

  test('GET /api/connect/status returns list of active connected accounts', async () => {
    const res = await request(app)
      .get('/api/connect/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connectedAccounts');
    expect(Array.isArray(res.body.connectedAccounts)).toBe(true);
    expect(res.body.connectedAccounts.length).toBeGreaterThan(0);
    expect(res.body.connectedAccounts[0]).toHaveProperty('provider', 'google_health');
    expect(res.body.connectedAccounts[0]).toHaveProperty('status', 'active');
  });

  test('POST /api/connect/google/disconnect marks connected account as disabled', async () => {
    const res = await request(app)
      .post('/api/connect/google/disconnect')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Disconnected Google Health account successfully');
  });
});
