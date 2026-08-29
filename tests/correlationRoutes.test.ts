import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { metricDefinitions, metricEntries } from '../src/db/schema';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-length';

describe('Phase 6 Slice 3 - Correlation Routes Integration (GET /api/metrics/correlation)', () => {
  let token: string;
  let testUserId: string;

  beforeAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', ['corr_routes_test@example.com']).catch(() => {});

    const res = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['corr_routes_test@example.com', 'hash']
    );
    testUserId = res.rows[0].id;
    token = jwt.sign({ id: testUserId, email: 'corr_routes_test@example.com' }, JWT_SECRET);

    // Create metrics for testing
    await db.insert(metricDefinitions).values([
      { userId: testUserId, metricType: 'route-corr-a', displayName: 'Route Corr A', valueType: 'numeric', unit: 'pts' },
      { userId: testUserId, metricType: 'route-corr-b', displayName: 'Route Corr B', valueType: 'numeric', unit: 'pts' },
    ]);

    const now = Date.now();
    // 3 aligned days (insufficient data)
    await db.insert(metricEntries).values([
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-a',
        startTime: new Date(now - 3 * 86400000),
        endTime: new Date(now - 3 * 86400000),
        valueNumeric: 10,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-b',
        startTime: new Date(now - 3 * 86400000),
        endTime: new Date(now - 3 * 86400000),
        valueNumeric: 100,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-a',
        startTime: new Date(now - 2 * 86400000),
        endTime: new Date(now - 2 * 86400000),
        valueNumeric: 12,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-b',
        startTime: new Date(now - 2 * 86400000),
        endTime: new Date(now - 2 * 86400000),
        valueNumeric: 120,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-a',
        startTime: new Date(now - 1 * 86400000),
        endTime: new Date(now - 1 * 86400000),
        valueNumeric: 14,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'route-corr-b',
        startTime: new Date(now - 1 * 86400000),
        endTime: new Date(now - 1 * 86400000),
        valueNumeric: 140,
      },
    ]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  });

  it('fails with 401 when token is missing', async () => {
    const res = await request(app).get('/api/metrics/correlation?metricTypeA=steps&metricTypeB=heart_rate');
    expect(res.status).toBe(401);
  });

  it('fails with 400 when metricTypeA or metricTypeB is missing', async () => {
    const res = await request(app)
      .get('/api/metrics/correlation?metricTypeA=steps')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid correlation query parameters');
  });

  it('fails with 400 when windowDays is below minimum (7)', async () => {
    const res = await request(app)
      .get('/api/metrics/correlation?metricTypeA=steps&metricTypeB=heart_rate&windowDays=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid correlation query parameters');
  });

  it('fails with 400 when comparing identical metrics', async () => {
    const res = await request(app)
      .get('/api/metrics/correlation?metricTypeA=steps&metricTypeB=steps')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot compute correlation of a metric with itself');
  });

  it('returns serialized insufficient_data with resolved windowDays on query override', async () => {
    const res = await request(app)
      .get('/api/metrics/correlation?metricTypeA=route-corr-a&metricTypeB=route-corr-b&windowDays=30')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      reason: 'insufficient_data',
      metricTypeA: 'route-corr-a',
      metricTypeB: 'route-corr-b',
      displayNameA: 'Route Corr A',
      displayNameB: 'Route Corr B',
      windowDays: 30,
      sampleSize: 3,
      minRequired: 10,
    });
  });

  it('returns serialized insufficient_data with default windowDays (90) when no override is passed', async () => {
    const res = await request(app)
      .get('/api/metrics/correlation?metricTypeA=route-corr-a&metricTypeB=route-corr-b')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      reason: 'insufficient_data',
      metricTypeA: 'route-corr-a',
      metricTypeB: 'route-corr-b',
      displayNameA: 'Route Corr A',
      displayNameB: 'Route Corr B',
      windowDays: 90,
      sampleSize: 3,
      minRequired: 10,
    });
  });
});
