const fs = require('fs');
const path = require('path');

function write(filePath, content) {
  const fullPath = path.join(__dirname, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim() + '\n', 'utf8');
  console.log('Created:', filePath);
}

// 1. tests/cryptoService.test.ts
write('tests/cryptoService.test.ts', `import { encryptToken, decryptToken, signState, verifyState } from '../src/services/cryptoService';

describe('cryptoService', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalEnv;
  });

  test('encrypts and decrypts OAuth token correctly', () => {
    const plainToken = 'ya29.a0Axoo-mock-google-oauth-access-token-123456';
    const encrypted = encryptToken(plainToken);
    
    expect(encrypted).not.toEqual(plainToken);
    expect(JSON.parse(encrypted)).toHaveProperty('iv');
    expect(JSON.parse(encrypted)).toHaveProperty('content');
    expect(JSON.parse(encrypted)).toHaveProperty('tag');

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toEqual(plainToken);
  });

  test('throws error if encrypted payload authTag is tampered with', () => {
    const plainToken = 'secret-refresh-token';
    const encrypted = encryptToken(plainToken);
    const parsed = JSON.parse(encrypted);
    parsed.tag = '00000000000000000000000000000000'; // Tampered tag

    expect(() => decryptToken(JSON.stringify(parsed))).toThrow();
  });

  test('signs and verifies state token with HMAC-SHA256', () => {
    const payload = { userId: 'user-uuid-123' };
    const signedToken = signState(payload);

    expect(typeof signedToken).toBe('string');
    expect(signedToken.split('.').length).toBe(2);

    const verifiedPayload = verifyState<{ userId: string }>(signedToken);
    expect(verifiedPayload.userId).toBe('user-uuid-123');
  });

  test('rejects tampered state token during verification (CSRF protection)', () => {
    const payload = { userId: 'user-uuid-123' };
    const signedToken = signState(payload);
    const [base64Data] = signedToken.split('.');
    const tamperedToken = \`\${base64Data}.invalid_hmac_signature\`;

    expect(() => verifyState(tamperedToken)).toThrow(/HMAC verification failed/i);
  });
});
`);

// 2. tests/dbSchema.test.ts
write('tests/dbSchema.test.ts', `import { metricEntries, connectedAccounts, users, syncRuns } from '../src/db/schema';
import { getTableColumns } from 'drizzle-orm';

describe('dbSchema verification', () => {
  test('metricEntries contains required columns with correct settings', () => {
    const columns = getTableColumns(metricEntries);

    expect(columns).toHaveProperty('id');
    expect(columns).toHaveProperty('userId');
    expect(columns).toHaveProperty('provider');
    expect(columns).toHaveProperty('metricType');
    expect(columns).toHaveProperty('externalId');
    expect(columns.startTime.notNull).toBe(true);
    expect(columns.endTime.notNull).toBe(true);
    expect(columns).toHaveProperty('valueNumeric');
    expect(columns).toHaveProperty('valueText');
    expect(columns).toHaveProperty('unit');
    expect(columns).toHaveProperty('sourceStream');
    expect(columns).toHaveProperty('aggregation');
    expect(columns).toHaveProperty('rawPayload');
    expect(columns).toHaveProperty('deletedAt');
  });

  test('connectedAccounts contains encrypted token columns and scopes', () => {
    const columns = getTableColumns(connectedAccounts);
    expect(columns).toHaveProperty('accessToken');
    expect(columns).toHaveProperty('refreshToken');
    expect(columns).toHaveProperty('scopes');
    expect(columns).toHaveProperty('status');
  });
});
`);

// 3. tests/connectRoutes.test.ts
write('tests/connectRoutes.test.ts', `import request from 'supertest';
import { app } from '../src/app';
import jwt from 'jsonwebtoken';
import { GoogleHealthAdapter } from '../src/adapters/googleHealthAdapter';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-length';

describe('Connect Routes API (Google OAuth)', () => {
  let authToken: string;
  const mockUser = { id: 'test-user-id-123', email: 'test@example.com' };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    authToken = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '1h' });
  });

  test('GET /api/connect/google/authorize generates signed state and required scopes', async () => {
    const res = await request(app)
      .get('/api/connect/google/authorize')
      .set('Authorization', \`Bearer \${authToken}\`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('authUrl');
    expect(res.body).toHaveProperty('signedState');
    expect(res.body.authUrl).toContain('accounts.google.com');
    expect(res.body.authUrl).toContain('activity_and_fitness');
    expect(res.body.authUrl).toContain('health_metrics_and_measurements');
    expect(res.body.requestedScopes).toContain('activity_and_fitness');
    expect(res.body.requestedScopes).toContain('health_metrics_and_measurements');
  });

  test('GET /api/connect/google/callback fails with 403 on invalid state parameter', async () => {
    const res = await request(app)
      .get('/api/connect/google/callback?code=mock_code&state=invalid_state');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid or tampered OAuth state/i);
  });

  test('GET /api/connect/google/callback succeeds with valid code and signed state', async () => {
    const authRes = await request(app)
      .get('/api/connect/google/authorize')
      .set('Authorization', \`Bearer \${authToken}\`);

    const signedState = authRes.body.signedState;

    const callbackRes = await request(app)
      .get(\`/api/connect/google/callback?code=test_oauth_code_999&state=\${encodeURIComponent(signedState)}\`);

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.message).toContain('successfully connected');
    expect(callbackRes.body.provider).toBe('google_health');
    expect(callbackRes.body.scopes).toContain('activity_and_fitness');
    expect(callbackRes.body.scopes).toContain('health_metrics_and_measurements');
  });
});
`);

// 4. tests/metricsQueryService.test.ts
write('tests/metricsQueryService.test.ts', `import { filterReconciledOverRaw } from '../src/services/metricsQueryService';
import { NormalizedMetricEntry } from '../src/adapters/baseAdapter';

describe('Metrics Canonical Query Path', () => {
  test('reconciled data stream overrides raw stream for overlapping time window', () => {
    const startTime = new Date('2026-08-01T10:00:00Z');
    const endTime = new Date('2026-08-01T10:05:00Z');

    const rawEntry: NormalizedMetricEntry = {
      userId: 'user-1',
      provider: 'google_health',
      metricType: 'heart_rate',
      externalId: 'raw-point-1',
      startTime,
      endTime,
      valueNumeric: 72,
      unit: 'bpm',
      sourceStream: 'raw',
      aggregation: 'raw',
    };

    const reconciledEntry: NormalizedMetricEntry = {
      userId: 'user-1',
      provider: 'google_health',
      metricType: 'heart_rate',
      startTime,
      endTime,
      valueNumeric: 70, // Reconciled value takes precedence
      unit: 'bpm',
      sourceStream: 'reconciled',
      aggregation: '5m_avg',
    };

    const combined = [rawEntry, reconciledEntry];
    const filtered = filterReconciledOverRaw(combined);

    expect(filtered.length).toBe(1);
    expect(filtered[0].sourceStream).toBe('reconciled');
    expect(filtered[0].valueNumeric).toBe(70);
  });
});
`);

console.log('Test files created successfully.');