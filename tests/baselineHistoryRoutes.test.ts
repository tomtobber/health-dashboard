import request from 'supertest';
import { app } from '../src/app';
import { db, pool } from '../src/db';
import { users, metricEntries, metricDefinitions } from '../src/db/schema';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';

describe('Phase 6 Slice 4 - Baseline History HTTP Routes', () => {
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metric_baseline_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        computed_at TIMESTAMP WITH TIME ZONE NOT NULL,
        window_days INTEGER NOT NULL,
        window_start TIMESTAMP WITH TIME ZONE NOT NULL,
        window_end TIMESTAMP WITH TIME ZONE NOT NULL,
        mean DOUBLE PRECISION NOT NULL,
        stddev DOUBLE PRECISION NOT NULL,
        min DOUBLE PRECISION NOT NULL,
        max DOUBLE PRECISION NOT NULL,
        sample_size INTEGER NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS metric_baseline_history_user_metric_computed_idx
        ON metric_baseline_history (user_id, metric_type, computed_at);
    `).catch(() => {});

    await pool.query('DELETE FROM users WHERE email = $1', ['history_routes_tester@example.com']).catch(() => {});

    const [u] = await db
      .insert(users)
      .values({
        email: 'history_routes_tester@example.com',
        passwordHash: 'hash123',
      })
      .returning();

    testUserId = u.id;
    const secret = process.env.JWT_SECRET || 'test-jwt-secret-key-1234567890123456';
    authToken = jwt.sign({ id: testUserId, email: u.email }, secret, { expiresIn: '1h' });

    // Seed 15 points
    const points = [];
    for (let i = 1; i <= 15; i++) {
      points.push({
        userId: testUserId,
        provider: 'manual',
        metricType: 'daily-steps-count',
        startTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
        endTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
        valueNumeric: 8000 + i * 100,
      });
    }
    await db.insert(metricEntries).values(points);

    // Custom boolean metric
    await db.insert(metricDefinitions).values({
      userId: testUserId,
      metricType: 'route-boolean-metric',
      displayName: 'Route Boolean',
      valueType: 'boolean',
    });
    await db.insert(metricEntries).values({
      userId: testUserId,
      provider: 'manual',
      metricType: 'route-boolean-metric',
      startTime: new Date('2026-01-10T10:00:00.000Z'),
      endTime: new Date('2026-01-10T10:00:00.000Z'),
      valueNumeric: 1,
    });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('POST /api/metrics/:metricType/baseline-history/refresh', () => {
    test('requires authentication', async () => {
      const res = await request(app).post('/api/metrics/daily-steps-count/baseline-history/refresh');
      expect(res.status).toBe(401);
    });

    test('returns 404 NotFoundError for non-existent metric or zero entries', async () => {
      const res = await request(app)
        .post('/api/metrics/non-existent-metric/baseline-history/refresh')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('code', 'NOT_FOUND_ERROR');
    });

    test('returns 400 ValidationError for boolean or category metric', async () => {
      const res = await request(app)
        .post('/api/metrics/route-boolean-metric/baseline-history/refresh')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    });

    test('successfully generates snapshots for the specified metric and returns summary', async () => {
      const res = await request(app)
        .post('/api/metrics/daily-steps-count/baseline-history/refresh')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('snapshotsAdded');
      expect(res.body).toHaveProperty('snapshotsSkippedExisting');
      expect(res.body).toHaveProperty('snapshotsSkippedInsufficientData');
      expect(res.body).toHaveProperty('hasMore');
      expect(res.body).not.toHaveProperty('metricsProcessed');
      expect(res.body).not.toHaveProperty('metricsSkippedNonApplicable');
    });
  });

  describe('GET /api/metrics/:metricType/baseline-history', () => {
    test('requires authentication', async () => {
      const res = await request(app).get('/api/metrics/daily-steps-count/baseline-history');
      expect(res.status).toBe(401);
    });

    test('validates startTime / endTime query parameters', async () => {
      const res = await request(app)
        .get('/api/metrics/daily-steps-count/baseline-history?startTime=invalid-date')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    });

    test('returns history items for metric', async () => {
      const res = await request(app)
        .get('/api/metrics/daily-steps-count/baseline-history')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('metricType', 'daily-steps-count');
      expect(res.body).toHaveProperty('history');
      expect(Array.isArray(res.body.history)).toBe(true);
    });
  });
});
