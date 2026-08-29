import { pool, db } from '../src/db';
import { metricDefinitions, metricEntries } from '../src/db/schema';
import {
  getMetricPairCorrelation,
  MIN_CORRELATION_SAMPLE_SIZE,
  CORRELATION_SIGNIFICANCE_THRESHOLD,
} from '../src/services/correlationService';
import { ValidationError } from '../src/errors/AppError';

describe('Phase 6 Slice 3 - Correlation Service Layer', () => {
  let testUserId: string;

  beforeAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', ['corr_service_test@example.com']).catch(() => {});
    const res = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['corr_service_test@example.com', 'dummy_hash']
    );
    testUserId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  });

  describe('Validation & Gating', () => {
    it('throws ValidationError when comparing a metric with itself', async () => {
      await expect(getMetricPairCorrelation(testUserId, 'metric-a', 'metric-a')).rejects.toThrow(
        ValidationError
      );
    });

    it('throws ValidationError if either metric is boolean or category', async () => {
      await db.insert(metricDefinitions).values([
        {
          userId: testUserId,
          metricType: 'corr-num',
          displayName: 'Numeric Metric',
          valueType: 'numeric',
          unit: 'pts',
        },
        {
          userId: testUserId,
          metricType: 'corr-bool',
          displayName: 'Boolean Metric',
          valueType: 'boolean',
        },
      ]);

      await expect(getMetricPairCorrelation(testUserId, 'corr-num', 'corr-bool')).rejects.toThrow(
        ValidationError
      );
    });

    it('returns insufficient_data with resolved windowDays when aligned paired days < 10', async () => {
      const metricA = 'sparse-a';
      const metricB = 'sparse-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'Sparse A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'Sparse B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      // Metric A has 5 days
      await db.insert(metricEntries).values(
        [1, 2, 3, 4, 5].map((d) => ({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: new Date(now - d * 86400000),
          endTime: new Date(now - d * 86400000),
          valueNumeric: 10 * d,
        }))
      );

      // Metric B has 5 days (days 3, 4, 5, 6, 7 -> intersection has only 3 days: 3, 4, 5)
      await db.insert(metricEntries).values(
        [3, 4, 5, 6, 7].map((d) => ({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: new Date(now - d * 86400000),
          endTime: new Date(now - d * 86400000),
          valueNumeric: 20 * d,
        }))
      );

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 45);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('insufficient_data');
        expect(res.metricTypeA).toBe(metricA);
        expect(res.metricTypeB).toBe(metricB);
        expect(res.windowDays).toBe(45);
        expect(res.sampleSize).toBe(3); // only days 3, 4, 5 aligned
        expect(res.minRequired).toBe(MIN_CORRELATION_SAMPLE_SIZE);
      }
    });
  });

  describe('Statistical Calculation & Gating', () => {
    it('computes perfect positive correlation (r = 1.0) and sets hasClearCorrelation to true', async () => {
      const metricA = 'perf-pos-a';
      const metricB = 'perf-pos-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'Perf Pos A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'Perf Pos B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      const entriesA: Array<typeof metricEntries.$inferInsert> = [];
      const entriesB: Array<typeof metricEntries.$inferInsert> = [];

      for (let d = 1; d <= 12; d++) {
        const time = new Date(now - d * 86400000);
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time,
          endTime: time,
          valueNumeric: 10 + d * 2,
        });
        entriesB.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: time,
          endTime: time,
          valueNumeric: 100 + d * 20,
        });
      }

      await db.insert(metricEntries).values([...entriesA, ...entriesB]);

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 90);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.sampleSize).toBe(12);
        expect(res.correlationCoefficient).toBe(1);
        expect(res.hasClearCorrelation).toBe(true);
        expect(res.pairedDailyAverages.length).toBe(12);
      }
    });

    it('computes perfect negative correlation (r = -1.0) and sets hasClearCorrelation to true', async () => {
      const metricA = 'perf-neg-a';
      const metricB = 'perf-neg-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'Perf Neg A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'Perf Neg B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      const entriesA: Array<typeof metricEntries.$inferInsert> = [];
      const entriesB: Array<typeof metricEntries.$inferInsert> = [];

      for (let d = 1; d <= 10; d++) {
        const time = new Date(now - d * 86400000);
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time,
          endTime: time,
          valueNumeric: d * 10,
        });
        entriesB.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: time,
          endTime: time,
          valueNumeric: 100 - d * 10,
        });
      }

      await db.insert(metricEntries).values([...entriesA, ...entriesB]);

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 90);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.sampleSize).toBe(10);
        expect(res.correlationCoefficient).toBe(-1);
        expect(res.hasClearCorrelation).toBe(true);
      }
    });

    it('correctly classifies noisy / weak correlation as hasClearCorrelation = false (|r| < 0.3)', async () => {
      const metricA = 'noisy-a';
      const metricB = 'noisy-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'Noisy A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'Noisy B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      // Orthogonal patterns: A increases monotonically, B oscillates around constant mean
      const aVals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const bVals = [50, 52, 48, 52, 48, 52, 48, 52, 48, 50];

      const entriesA: Array<typeof metricEntries.$inferInsert> = [];
      const entriesB: Array<typeof metricEntries.$inferInsert> = [];

      for (let i = 0; i < 10; i++) {
        const time = new Date(now - (10 - i) * 86400000);
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time,
          endTime: time,
          valueNumeric: aVals[i],
        });
        entriesB.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: time,
          endTime: time,
          valueNumeric: bVals[i],
        });
      }

      await db.insert(metricEntries).values([...entriesA, ...entriesB]);

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 90);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(Math.abs(res.correlationCoefficient)).toBeLessThan(CORRELATION_SIGNIFICANCE_THRESHOLD);
        expect(res.hasClearCorrelation).toBe(false);
      }
    });

    it('guards zero-variance case: if all daily values in metric B are constant, returns r = 0 and hasClearCorrelation = false', async () => {
      const metricA = 'const-var-a';
      const metricB = 'const-var-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'Const Var A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'Const Var B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      const entriesA: Array<typeof metricEntries.$inferInsert> = [];
      const entriesB: Array<typeof metricEntries.$inferInsert> = [];

      for (let d = 1; d <= 10; d++) {
        const time = new Date(now - d * 86400000);
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time,
          endTime: time,
          valueNumeric: d * 5,
        });
        entriesB.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: time,
          endTime: time,
          valueNumeric: 70, // Syy == 0
        });
      }

      await db.insert(metricEntries).values([...entriesA, ...entriesB]);

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 90);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.correlationCoefficient).toBe(0);
        expect(res.hasClearCorrelation).toBe(false);
      }
    });

    it('averages multiple intra-day entries per UTC day before correlating', async () => {
      const metricA = 'multiday-a';
      const metricB = 'multiday-b';

      await db.insert(metricDefinitions).values([
        { userId: testUserId, metricType: metricA, displayName: 'MultiDay A', valueType: 'numeric', unit: 'pts' },
        { userId: testUserId, metricType: metricB, displayName: 'MultiDay B', valueType: 'numeric', unit: 'pts' },
      ]);

      const now = Date.now();
      const entriesA: Array<typeof metricEntries.$inferInsert> = [];
      const entriesB: Array<typeof metricEntries.$inferInsert> = [];

      for (let d = 1; d <= 10; d++) {
        const time1 = new Date(now - d * 86400000);
        const time2 = new Date(now - d * 86400000 + 3600000);

        // Day d for A has two samples: (d*10) and (d*10 + 20) -> mean is d*10 + 10
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time1,
          endTime: time1,
          valueNumeric: d * 10,
        });
        entriesA.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricA,
          startTime: time2,
          endTime: time2,
          valueNumeric: d * 10 + 20,
        });

        // Day d for B has single sample
        entriesB.push({
          userId: testUserId,
          provider: 'manual',
          metricType: metricB,
          startTime: time1,
          endTime: time1,
          valueNumeric: d * 10 + 10,
        });
      }

      await db.insert(metricEntries).values([...entriesA, ...entriesB]);

      const res = await getMetricPairCorrelation(testUserId, metricA, metricB, 90);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.sampleSize).toBe(10);
        expect(res.correlationCoefficient).toBe(1);
        expect(res.hasClearCorrelation).toBe(true);
      }
    });
  });
});
