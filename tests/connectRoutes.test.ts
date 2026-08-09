import request from 'supertest';
import { app } from '../src/app';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';
import { encryptToken } from '../src/services/cryptoService';
import { CryptographicError } from '../src/errors/AppError';

describe('Connect Routes API (Google OAuth)', () => {
  let authToken: string;
  const mockUser = { id: 'test-user-id-123', email: 'test@example.com' };

  beforeAll(() => {
    authToken = jwt.sign(mockUser, env.JWT_SECRET, { expiresIn: '1h' });
  });

  test('GET /api/connect/google/authorize generates signed state and required scopes', async () => {
    const res = await request(app)
      .get('/api/connect/google/authorize')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('authUrl');
    expect(res.body).toHaveProperty('signedState');
    expect(res.body.authUrl).toContain('accounts.google.com');
    expect(res.body.authUrl).toContain('activity_and_fitness');
    expect(res.body.authUrl).toContain('health_metrics_and_measurements');
    expect(res.body.requestedScopes).toContain('activity_and_fitness');
    expect(res.body.requestedScopes).toContain('health_metrics_and_measurements');
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
    expect(callbackRes.body.scopes).toContain('activity_and_fitness');
    expect(callbackRes.body.scopes).toContain('health_metrics_and_measurements');
  });
});
