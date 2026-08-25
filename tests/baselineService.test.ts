import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries, metricBaselineConfigs } from '../src/db/schema';
import {
  getMetricBaseline,
  getBaselineConfig,
  setBaselineConfig,
  DEFAULT_BASELINE_WINDOW_DAYS,
  MIN_BASELINE_SAMPLE_SIZE,
} from '../src/services/baselineService';
import { ValidationError } from '../src/errors/AppError';
import { eq } from 'drizzle-orm';

describe('Phase 6 - Personal Baselines Service Layer', () => {
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
      'baseline_service_tester@example.com',
      'baseline_service_other@example.com',
    ]).catch(() => {});

    const [u1] = await db
      .insert(users)
      .values({
        email: 'baseline_service_tester@example.com',
        passwordHash: 'hash123',
      })
      .returning();

    const [u2] = await db
      .insert(users)
      .values({
        email: 'baseline_service_other@example.com',
        passwordHash: 'hash456',
      })
      .returning();

    testUserId = u1.id;
    otherUserId = u2.id;

    // Create custom numeric, duration, boolean, and category metric definitions
    await db.insert(metricDefinitions).values([
      {
        userId: testUserId,
        metricType: 'daily-coffee-cups',
        displayName: 'Daily Coffee Cups',
        valueType: 'numeric',
        unit: 'cups',
      },
      {
        userId: testUserId,
        metricType: 'workout-duration',
        displayName: 'Workout Duration',
        valueType: 'duration',
        unit: 's',
      },
      {
        userId: testUserId,
        metricType: 'morning-meditation',
        displayName: 'Morning Meditation',
        valueType: 'boolean',
        unit: null,
      },
      {
        userId: testUserId,
        metricType: 'daily-mood',
        displayName: 'Daily Mood',
        valueType: 'category',
        unit: null,
        categoryValues: ['great', 'neutral', 'low'],
      },
    ]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, otherUserId]).catch(() => {});
  });

  describe('Mathematical Accuracy & Bessel Correction', () => {
    it('computes exact mean, sample stddev (N-1), min, max for known dataset (N >= 10)', async () => {
      // Synthetic dataset: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28] -> N = 10
      // Sum = 190, Mean = 19.00
      // Deviations from 19: [-9, -7, -5, -3, -1, 1, 3, 5, 7, 9]
      // Squared deviations: [81, 49, 25, 9, 1, 1, 9, 25, 49, 81] -> Sum = 330
      // Sample Variance (N - 1 = 9): 330 / 9 = 36.6666...
      // Sample Stddev: sqrt(36.6666...) = 6.0553... -> 6.06
      // Min = 10.00, Max = 28.00
      const now = new Date();
      const rawValues = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
      for (let i = 0; i < rawValues.length; i++) {
        const time = new Date(now.getTime() - (i + 1) * 86400000);
        await db.insert(metricEntries).values({
          userId: testUserId,
          provider: 'manual',
          metricType: 'daily-coffee-cups',
          startTime: time,
          endTime: time,
          valueNumeric: rawValues[i],
          unit: 'cups',
          dimension: 'default',
          sourceStream: null,
          aggregation: 'raw',
        });
      }

      const result = await getMetricBaseline(testUserId, 'daily-coffee-cups');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.metricType).toBe('daily-coffee-cups');
        expect(result.displayName).toBe('Daily Coffee Cups');
        expect(result.unit).toBe('cups');
        expect(result.sampleSize).toBe(10);
        expect(result.mean).toBe(19);
        expect(result.stddev).toBe(6.06);
        expect(result.min).toBe(10);
        expect(result.max).toBe(28);
        expect(result.windowDays).toBe(DEFAULT_BASELINE_WINDOW_DAYS);
        expect(new Date(result.windowStart).getTime()).toBeLessThan(new Date(result.windowEnd).getTime());
      }
    });

    it('works with canonical provider metrics (e.g. heart_rate)', async () => {
      const now = new Date();
      for (let i = 0; i < 12; i++) {
        const time = new Date(now.getTime() - (i + 1) * 3600000);
        await db.insert(metricEntries).values({
          userId: testUserId,
          provider: 'google_health',
          metricType: 'heart_rate',
          startTime: time,
          endTime: time,
          valueNumeric: 70 + i,
          unit: 'bpm',
          dimension: 'default',
          sourceStream: 'reconciled',
          aggregation: 'raw',
        });
      }

      const result = await getMetricBaseline(testUserId, 'heart_rate');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.metricType).toBe('heart_rate');
        expect(result.displayName).toBe('Heart Rate');
        expect(result.unit).toBe('bpm');
        expect(result.sampleSize).toBe(12);
        expect(result.min).toBe(70);
        expect(result.max).toBe(81);
      }
    });
  });

  describe('Minimum Sample Size Gate (< 10 items)', () => {
    it('returns discriminated union { ok: false, reason: "insufficient_data" } when samples < 10', async () => {
      const now = new Date();
      // Insert only 5 entries for workout-duration
      for (let i = 0; i < 5; i++) {
        const time = new Date(now.getTime() - (i + 1) * 86400000);
        await db.insert(metricEntries).values({
          userId: testUserId,
          provider: 'manual',
          metricType: 'workout-duration',
          startTime: time,
          endTime: time,
          valueNumeric: 1800,
          unit: 's',
          dimension: 'default',
          sourceStream: null,
          aggregation: 'raw',
        });
      }

      const result = await getMetricBaseline(testUserId, 'workout-duration');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('insufficient_data');
        expect(result.metricType).toBe('workout-duration');
        expect(result.displayName).toBe('Workout Duration');
        expect(result.sampleSize).toBe(5);
        expect(result.minRequired).toBe(MIN_BASELINE_SAMPLE_SIZE);
      }
    });
  });

  describe('Value Type Validation', () => {
    it('throws ValidationError when requesting baseline for boolean metric', async () => {
      await expect(getMetricBaseline(testUserId, 'morning-meditation')).rejects.toThrow(
        ValidationError
      );
    });

    it('throws ValidationError when requesting baseline for category metric', async () => {
      await expect(getMetricBaseline(testUserId, 'daily-mood')).rejects.toThrow(
        ValidationError
      );
    });
  });

  describe('Window Resolution (Default vs Configured vs Query Override)', () => {
    it('returns default (90) when no baseline config is saved', async () => {
      const config = await getBaselineConfig(testUserId, 'daily-coffee-cups');
      expect(config).toEqual({
        configured: false,
        metricType: 'daily-coffee-cups',
        default: 90,
      });
    });

    it('saves and applies custom window config (e.g. 30 days)', async () => {
      const saved = await setBaselineConfig(testUserId, 'daily-coffee-cups', 30);
      expect(saved).toEqual({
        configured: true,
        metricType: 'daily-coffee-cups',
        windowDays: 30,
      });

      const config = await getBaselineConfig(testUserId, 'daily-coffee-cups');
      expect(config).toEqual({
        configured: true,
        metricType: 'daily-coffee-cups',
        windowDays: 30,
      });

      const baseline = await getMetricBaseline(testUserId, 'daily-coffee-cups');
      expect(baseline.ok).toBe(true);
      if (baseline.ok) {
        expect(baseline.windowDays).toBe(30);
      }
    });

    it('query override takes precedence without persisting', async () => {
      const baseline = await getMetricBaseline(testUserId, 'daily-coffee-cups', 180);
      expect(baseline.ok).toBe(true);
      if (baseline.ok) {
        expect(baseline.windowDays).toBe(180);
      }

      // Check that saved config remains 30
      const config = await getBaselineConfig(testUserId, 'daily-coffee-cups');
      expect(config).toEqual({
        configured: true,
        metricType: 'daily-coffee-cups',
        windowDays: 30,
      });
    });

    it('upsert uniqueness on (user_id, metric_type) cleanly overwrites existing config', async () => {
      await setBaselineConfig(testUserId, 'daily-coffee-cups', 60);
      const rows = await db
        .select()
        .from(metricBaselineConfigs)
        .where(eq(metricBaselineConfigs.userId, testUserId));

      const coffeeConfigs = rows.filter((r) => r.metricType === 'daily-coffee-cups');
      expect(coffeeConfigs.length).toBe(1);
      expect(coffeeConfigs[0].windowDays).toBe(60);
    });

    it('rejects setBaselineConfig for boolean or category metrics', async () => {
      await expect(setBaselineConfig(testUserId, 'morning-meditation', 30)).rejects.toThrow(
        ValidationError
      );
      await expect(setBaselineConfig(testUserId, 'daily-mood', 30)).rejects.toThrow(
        ValidationError
      );
    });
  });
});
