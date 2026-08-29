import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries } from '../src/db/schema';
import {
  getMetricTrend,
  MIN_TREND_SAMPLE_SIZE,
  TREND_CORRELATION_THRESHOLD,
} from '../src/services/baselineService';
import { ValidationError } from '../src/errors/AppError';

describe('Phase 6 - Trend Detection Service Layer', () => {
  let testUserId: string;
  let otherUserId: string;

  beforeAll(async () => {
    // Idempotent schema bootstrap
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

    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'trend_service_tester@example.com',
      'trend_service_other@example.com',
    ]).catch(() => {});

    const [u1] = await db
      .insert(users)
      .values({
        email: 'trend_service_tester@example.com',
        passwordHash: 'hash123',
      })
      .returning();

    const [u2] = await db
      .insert(users)
      .values({
        email: 'trend_service_other@example.com',
        passwordHash: 'hash456',
      })
      .returning();

    testUserId = u1.id;
    otherUserId = u2.id;

    // Create custom metric definitions
    await db.insert(metricDefinitions).values([
      {
        userId: testUserId,
        metricType: 'trend-steps',
        displayName: 'Trend Steps',
        valueType: 'numeric',
        unit: 'steps',
      },
      {
        userId: testUserId,
        metricType: 'trend-weight',
        displayName: 'Trend Weight',
        valueType: 'numeric',
        unit: 'kg',
      },
      {
        userId: testUserId,
        metricType: 'trend-flat',
        displayName: 'Trend Flat',
        valueType: 'numeric',
        unit: 'bpm',
      },
      {
        userId: testUserId,
        metricType: 'trend-noisy',
        displayName: 'Trend Noisy',
        valueType: 'numeric',
        unit: 'score',
      },
      {
        userId: testUserId,
        metricType: 'trend-bool',
        displayName: 'Trend Boolean',
        valueType: 'boolean',
        unit: null,
      },
    ]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, otherUserId]).catch(() => {});
  });

  describe('Zero-Variance Guard', () => {
    it('returns slope 0, r 0, and direction no_clear_trend when all daily values in the window are identical', async () => {
      const now = Date.now();
      const entriesToInsert = [];

      // 15 consecutive days with identical value of 70
      for (let i = 15; i >= 1; i--) {
        const time = new Date(now - i * 86400000);
        entriesToInsert.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'trend-flat',
          startTime: time,
          endTime: time,
          valueNumeric: 70,
          unit: 'bpm',
          sourceStream: null,
        });
      }

      await db.insert(metricEntries).values(entriesToInsert);

      const result = await getMetricTrend(testUserId, 'trend-flat', 30);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(15);
        expect(result.slopePerDay).toBe(0);
        expect(result.correlationCoefficient).toBe(0);
        expect(result.direction).toBe('no_clear_trend');
      }
    });
  });

  describe('OLS Linear Regression & Direction Classification', () => {
    it('detects an increasing trend when r >= 0.3 and slope > 0', async () => {
      const now = Date.now();
      const entriesToInsert = [];

      // 12 days increasing from 5000 to 16000 steps
      for (let i = 12; i >= 1; i--) {
        const time = new Date(now - i * 86400000);
        const val = 5000 + (12 - i) * 1000;
        entriesToInsert.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'trend-steps',
          startTime: time,
          endTime: time,
          valueNumeric: val,
          unit: 'steps',
          sourceStream: null,
        });
      }

      await db.insert(metricEntries).values(entriesToInsert);

      const result = await getMetricTrend(testUserId, 'trend-steps', 30);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(12);
        expect(result.direction).toBe('increasing');
        expect(result.slopePerDay).toBeGreaterThan(0);
        expect(result.correlationCoefficient).toBeGreaterThanOrEqual(TREND_CORRELATION_THRESHOLD);
      }
    });

    it('detects a decreasing trend when r <= -0.3 and slope < 0', async () => {
      const now = Date.now();
      const entriesToInsert = [];

      // 14 days decreasing from 80kg to 77.4kg (-0.2kg per day)
      for (let i = 14; i >= 1; i--) {
        const time = new Date(now - i * 86400000);
        const val = 80 - (14 - i) * 0.2;
        entriesToInsert.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'trend-weight',
          startTime: time,
          endTime: time,
          valueNumeric: val,
          unit: 'kg',
          sourceStream: null,
        });
      }

      await db.insert(metricEntries).values(entriesToInsert);

      const result = await getMetricTrend(testUserId, 'trend-weight', 30);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(14);
        expect(result.direction).toBe('decreasing');
        expect(result.slopePerDay).toBeLessThan(0);
        expect(result.correlationCoefficient).toBeLessThanOrEqual(-TREND_CORRELATION_THRESHOLD);
      }
    });

    it('classifies noisy data with |r| < 0.3 as no_clear_trend regardless of slight slope', async () => {
      const now = Date.now();
      const entriesToInsert = [];

      // Alternating/noisy values around 50
      const noisyVals = [50, 48, 52, 49, 51, 50, 48, 52, 49, 51, 50, 49];
      for (let i = noisyVals.length; i >= 1; i--) {
        const time = new Date(now - i * 86400000);
        const val = noisyVals[noisyVals.length - i]!;
        entriesToInsert.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'trend-noisy',
          startTime: time,
          endTime: time,
          valueNumeric: val,
          unit: 'score',
          sourceStream: null,
        });
      }

      await db.insert(metricEntries).values(entriesToInsert);

      const result = await getMetricTrend(testUserId, 'trend-noisy', 30);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(12);
        expect(Math.abs(result.correlationCoefficient)).toBeLessThan(TREND_CORRELATION_THRESHOLD);
        expect(result.direction).toBe('no_clear_trend');
      }
    });
  });

  describe('Calendar Gaps & Intra-Day Aggregation', () => {
    it('averages multiple intra-day entries and correctly weights calendar distance with gap days', async () => {
      const now = Date.now();
      // Insert multiple entries on day -10 (e.g. 100, 110 -> mean 105),
      // day -8 (gap at -9), and 10 more days to reach sampleSize >= 10
      const multiDayMetric = 'trend-multiday';
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: multiDayMetric,
        displayName: 'Multi-Day Metric',
        valueType: 'numeric',
        unit: 'pts',
      });

      const entries = [
        // Day -12 (two points)
        {
          userId: testUserId,
          provider: 'manual',
          metricType: multiDayMetric,
          startTime: new Date(now - 12 * 86400000),
          endTime: new Date(now - 12 * 86400000),
          valueNumeric: 10,
        },
        {
          userId: testUserId,
          provider: 'manual',
          metricType: multiDayMetric,
          startTime: new Date(now - 12 * 86400000 + 3600000),
          endTime: new Date(now - 12 * 86400000 + 3600000),
          valueNumeric: 20,
        },
        // 9 additional distinct days (with gaps)
        ...[10, 8, 7, 6, 5, 4, 3, 2, 1].map((d, idx) => ({
          userId: testUserId,
          provider: 'manual',
          metricType: multiDayMetric,
          startTime: new Date(now - d * 86400000),
          endTime: new Date(now - d * 86400000),
          valueNumeric: 30 + idx * 5,
        })),
      ];

      await db.insert(metricEntries).values(entries);

      const result = await getMetricTrend(testUserId, multiDayMetric, 30);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(10); // 10 distinct days
        expect(result.direction).toBe('increasing');
      }
    });
  });

  describe('Sample Size Gating & Validation', () => {
    it('returns insufficient_data when distinct days with data < 10', async () => {
      const sparseMetric = 'trend-sparse';
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: sparseMetric,
        displayName: 'Sparse Metric',
        valueType: 'numeric',
        unit: 'pts',
      });

      const now = Date.now();
      const entries = [1, 2, 3, 4, 5].map((d) => ({
        userId: testUserId,
        provider: 'manual',
        metricType: sparseMetric,
        startTime: new Date(now - d * 86400000),
        endTime: new Date(now - d * 86400000),
        valueNumeric: 100,
      }));

      await db.insert(metricEntries).values(entries);

      const result = await getMetricTrend(testUserId, sparseMetric, 30);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('insufficient_data');
        expect(result.windowDays).toBe(30);
        expect(result.sampleSize).toBe(5);
        expect(result.minRequired).toBe(MIN_TREND_SAMPLE_SIZE);
      }

      // Assert default windowDays (90) on insufficient data path when no override provided
      const defaultResult = await getMetricTrend(testUserId, sparseMetric);
      expect(defaultResult.ok).toBe(false);
      if (!defaultResult.ok) {
        expect(defaultResult.windowDays).toBe(90);
      }
    });

    it('rejects boolean or category metrics with ValidationError', async () => {
      await expect(getMetricTrend(testUserId, 'trend-bool')).rejects.toThrow(ValidationError);
    });
  });
});
