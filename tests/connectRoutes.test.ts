import request from 'supertest';
import { app } from '../src/app';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';
import { encryptToken } from '../src/services/cryptoService';
import { CryptographicError } from '../src/errors/AppError';
import { GoogleHealthAdapter } from '../src/adapters/googleHealthAdapter';
import { db, pool } from '../src/db';
import { users, connectedAccounts } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Connect Routes API (Google OAuth)', () => {
  let authToken: string;
  let testUserId: string;
  const isNeonDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'));

  beforeAll(async () => {
    if (isNeonDb) {
      // Clean up if exists
      await pool.query('DELETE FROM users WHERE email = $1', ['connect_test@example.com']);

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
    } else {
      testUserId = 'b0000000-0000-0000-0000-000000000002';
    }

    authToken = jwt.sign({ id: testUserId, email: 'connect_test@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (isNeonDb && testUserId) {
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
    expect(res.body).toHaveProperty('signedState');

    const expectedScopes = [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
      'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    ];

    expect(res.body.requestedScopes).toEqual(expectedScopes);
    expect(res.body.requestedScopes).toEqual(GoogleHealthAdapter.SCOPES);

    const expectedScopeParam = expectedScopes.map((s) => encodeURIComponent(s)).join('+');
    expect(res.body.authUrl).toContain(`scope=${expectedScopeParam}`);
  });

  test('GET /api/connect/google/callback fails with 400 Bad Request CryptographicError on tampered client state parameter', async () => {
    const res = await request(app)
      .get('/api/connect/google/callback?code=mock_code&state=invalid_state');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CRYPTOGRAPHIC_ERROR');
    expect(res.body.error).toMatch(/state token/i);
  });

  test('Server-side crypto key failure retains 500 status code', () => {
    const originalKey = env.ENCRYPTION_KEY;
    const envObj = env as unknown as Record<string, string>;
    try {
      envObj.ENCRYPTION_KEY = 'invalid_non_hex_key_$$$';
      expect(() => encryptToken('test')).toThrow(CryptographicError);
      try {
        encryptToken('test');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CryptographicError);
        expect((err as CryptographicError).statusCode).toBe(500);
      }
    } finally {
      envObj.ENCRYPTION_KEY = originalKey;
    }
  });

  test('GET /api/connect/google/callback succeeds with valid code and signed state', async () => {
    const authRes = await request(app)
      .get('/api/connect/google/authorize')
      .set('Authorization', `Bearer ${authToken}`);

    const signedState = authRes.body.signedState;

    const callbackRes = await request(app)
      .get(`/api/connect/google/callback?code=test_oauth_code_999&state=${encodeURIComponent(signedState)}`);

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.message).toContain('successfully connected');
    expect(callbackRes.body.provider).toBe('google_health');
    expect(callbackRes.body.scopes).toEqual(GoogleHealthAdapter.SCOPES);
  });

  test('POST /api/connect/google/sync-subscription updates existing webhook subscription to latest metric types', async () => {
    const res = await request(app)
      .post('/api/connect/google/sync-subscription')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('active', true);
    expect(res.body.message).toContain('updated');
  });
});
