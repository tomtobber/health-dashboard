import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries } from '../src/db/schema';

describe('Phase 6 - Personal Baselines HTTP Routes', () => {
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metric_baseline_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        window_days INTEGER NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS metric_baseline_configs_user_metric_idx
        ON metric_baseline_configs (user_id, metric_type);
    `).catch(() => {});

    await pool.query('DELETE FROM users WHERE email = $1', [
      'baseline_route_tester@example.com',
    ]).catch(() => {});

    const [u] = await db
      .insert(users)
      .values({
        email: 'baseline_route_tester@example.com',
        passwordHash: 'hash_route_123',
      })
      .returning();

    testUserId = u.id;
    authToken = jwt.sign(
      { id: testUserId, email: 'baseline_route_tester@example.com' },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Create a numeric metric definition and 15 entries
    await db.insert(metricDefinitions).values({
      userId: testUserId,
      metricType: 'water-intake-liters',
      displayName: 'Water Intake',
      valueType: 'numeric',
      unit: 'L',
    });

    const now = new Date();
    for (let i = 0; i < 15; i++) {
      const time = new Date(now.getTime() - (i + 1) * 86400000);
      await db.insert(metricEntries).values({
        userId: testUserId,
        provider: 'manual',
        metricType: 'water-intake-liters',
        startTime: time,
        endTime: time,
        valueNumeric: 2.0 + (i % 3) * 0.5, // 2.0, 2.5, 3.0
        unit: 'L',
        dimension: 'default',
        sourceStream: null,
        aggregation: 'raw',
      });
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  });

  describe('GET /api/metrics/:metricType/baseline', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/metrics/water-intake-liters/baseline');
      expect(res.status).toBe(401);
    });

    it('returns calculated baseline with default window (90 days)', async () => {
      const res = await request(app)
        .get('/api/metrics/water-intake-liters/baseline')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.metricType).toBe('water-intake-liters');
      expect(res.body.displayName).toBe('Water Intake');
      expect(res.body.unit).toBe('L');
      expect(res.body.sampleSize).toBe(15);
      expect(res.body.windowDays).toBe(90);
      expect(typeof res.body.mean).toBe('number');
      expect(typeof res.body.stddev).toBe('number');
      expect(typeof res.body.min).toBe('number');
      expect(typeof res.body.max).toBe('number');
    });

    it('accepts valid ?windowDays= override', async () => {
      const res = await request(app)
        .get('/api/metrics/water-intake-liters/baseline?windowDays=14')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.windowDays).toBe(14);
    });

    it('rejects out-of-bounds ?windowDays= override (too small < 7)', async () => {
      const res = await request(app)
        .get('/api/metrics/water-intake-liters/baseline?windowDays=3')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });


    it('returns insufficient_data with metricType and displayName when sample size < 10 over HTTP', async () => {
      // Create a metric with only 3 entries
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: 'daily-stretch-minutes',
        displayName: 'Daily Stretching',
        valueType: 'duration',
        unit: 'minutes',
      });

      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const time = new Date(now.getTime() - (i + 1) * 86400000);
        await db.insert(metricEntries).values({
          userId: testUserId,
          provider: 'manual',
          metricType: 'daily-stretch-minutes',
          startTime: time,
          endTime: time,
          valueNumeric: 15,
          unit: 'minutes',
          dimension: 'default',
          sourceStream: null,
          aggregation: 'raw',
        });
      }

      const res = await request(app)
        .get('/api/metrics/daily-stretch-minutes/baseline')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: false,
        reason: 'insufficient_data',
        metricType: 'daily-stretch-minutes',
        displayName: 'Daily Stretching',
        windowDays: 90,
        sampleSize: 3,
        minRequired: 10,
      });
    });
    it('rejects out-of-bounds ?windowDays= override (too large > 3650)', async () => {
      const res = await request(app)
        .get('/api/metrics/water-intake-liters/baseline?windowDays=5000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/metrics/:metricType/baseline-config & PUT /api/metrics/:metricType/baseline-config', () => {
    it('returns unconfigured default initially', async () => {
      const res = await request(app)
        .get('/api/metrics/water-intake-liters/baseline-config')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        configured: false,
        metricType: 'water-intake-liters',
        default: 90,
      });
    });

    it('upserts valid configuration via PUT', async () => {
      const res = await request(app)
        .put('/api/metrics/water-intake-liters/baseline-config')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ windowDays: 45 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        configured: true,
        metricType: 'water-intake-liters',
        windowDays: 45,
      });

      // Verify GET returns configured value
      const getRes = await request(app)
        .get('/api/metrics/water-intake-liters/baseline-config')
        .set('Authorization', `Bearer ${authToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({
        configured: true,
        metricType: 'water-intake-liters',
        windowDays: 45,
      });
    });

    it('rejects PUT with windowDays < 7', async () => {
      const res = await request(app)
        .put('/api/metrics/water-intake-liters/baseline-config')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ windowDays: 6 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects PUT with windowDays > 3650', async () => {
      const res = await request(app)
        .put('/api/metrics/water-intake-liters/baseline-config')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ windowDays: 4000 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
