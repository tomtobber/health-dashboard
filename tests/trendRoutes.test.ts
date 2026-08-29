import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { metricDefinitions, metricEntries } from '../src/db/schema';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-length';

describe('Trend Routes Integration (GET /api/metrics/:metricType/trend)', () => {
  let token: string;
  let testUserId: string;

  beforeAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', ['trend_routes_test@example.com']).catch(() => {});

    const res = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['trend_routes_test@example.com', 'hash']
    );
    testUserId = res.rows[0].id;
    token = jwt.sign({ id: testUserId, email: 'trend_routes_test@example.com' }, JWT_SECRET);

    // Create a sparse metric definition for insufficient_data testing
    await db.insert(metricDefinitions).values({
      userId: testUserId,
      metricType: 'trend-sparse-route',
      displayName: 'Sparse Route Metric',
      valueType: 'numeric',
      unit: 'pts',
    });

    const now = Date.now();
    await db.insert(metricEntries).values([
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'trend-sparse-route',
        startTime: new Date(now - 3 * 86400000),
        endTime: new Date(now - 3 * 86400000),
        valueNumeric: 10,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'trend-sparse-route',
        startTime: new Date(now - 2 * 86400000),
        endTime: new Date(now - 2 * 86400000),
        valueNumeric: 12,
      },
      {
        userId: testUserId,
        provider: 'manual',
        metricType: 'trend-sparse-route',
        startTime: new Date(now - 1 * 86400000),
        endTime: new Date(now - 1 * 86400000),
        valueNumeric: 14,
      },
    ]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  });

  it('fails with 401 when token is missing', async () => {
    const res = await request(app).get('/api/metrics/steps/trend');
    expect(res.status).toBe(401);
  });

  it('fails with 400 when windowDays is below minimum (7)', async () => {
    const res = await request(app)
      .get('/api/metrics/steps/trend?windowDays=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid windowDays');
  });

  it('returns serialized insufficient_data response with correct resolved windowDays on query override', async () => {
    const res = await request(app)
      .get('/api/metrics/trend-sparse-route/trend?windowDays=30')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      reason: 'insufficient_data',
      metricType: 'trend-sparse-route',
      displayName: 'Sparse Route Metric',
      windowDays: 30,
      sampleSize: 3,
      minRequired: 10,
    });
  });

  it('returns serialized insufficient_data response with default windowDays (90) when no override is provided', async () => {
    const res = await request(app)
      .get('/api/metrics/trend-sparse-route/trend')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      reason: 'insufficient_data',
      metricType: 'trend-sparse-route',
      displayName: 'Sparse Route Metric',
      windowDays: 90,
      sampleSize: 3,
      minRequired: 10,
    });
  });

  it('succeeds and returns TrendResult structure for valid request', async () => {
    const res = await request(app)
      .get('/api/metrics/steps/trend?windowDays=90')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('metricType', 'steps');
  });
});
