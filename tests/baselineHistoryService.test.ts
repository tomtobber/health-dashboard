import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries } from '../src/db/schema';
import {
  refreshBaselineHistory,
  getMetricBaselineHistory,
  getFullyElapsedMonthBoundaries,
  BASELINE_HISTORY_WINDOW_DAYS,
} from '../src/services/baselineHistoryService';
import { computeMetricBaseline, getMetricBaseline } from '../src/services/baselineService';
import { eq } from 'drizzle-orm';

describe('Phase 6 Slice 4 - Baseline History Service Layer', () => {
  let testUserId: string;
  let otherUserId: string;

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

    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'history_service_tester@example.com',
      'history_service_other@example.com',
    ]).catch(() => {});

    const [u1] = await db
      .insert(users)
      .values({
        email: 'history_service_tester@example.com',
        passwordHash: 'hash123',
      })
      .returning();

    const [u2] = await db
      .insert(users)
      .values({
        email: 'history_service_other@example.com',
        passwordHash: 'hash456',
      })
      .returning();

    testUserId = u1.id;
    otherUserId = u2.id;

    // Define numeric and boolean custom metrics
    await db.insert(metricDefinitions).values([
      {
        userId: testUserId,
        metricType: 'morning-weight-kg',
        displayName: 'Morning Weight',
        valueType: 'numeric',
        unit: 'kg',
      },
      {
        userId: testUserId,
        metricType: 'took-medication',
        displayName: 'Took Medication',
        valueType: 'boolean',
      },
    ]);
  });

  afterAll(async () => {
    if (testUserId && otherUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
      await db.delete(users).where(eq(users.id, otherUserId));
    }
  });

  describe('1. Month Boundary Generation & Exclusion of In-Progress Month', () => {
    test('generates expected UTC 1st-of-month boundaries and excludes in-progress month', () => {
      const earliest = new Date('2025-11-15T12:00:00.000Z');
      const now = new Date('2026-03-20T15:30:00.000Z');

      const boundaries = getFullyElapsedMonthBoundaries(earliest, now);

      expect(boundaries.length).toBe(4);
      expect(boundaries[0].toISOString()).toBe('2025-12-01T00:00:00.000Z');
      expect(boundaries[1].toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(boundaries[2].toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(boundaries[3].toISOString()).toBe('2026-03-01T00:00:00.000Z');
      // In-progress month (April 1st, 2026) is excluded
    });

    test('returns empty array when earliest entry is in current in-progress month', () => {
      const earliest = new Date('2026-03-10T10:00:00.000Z');
      const now = new Date('2026-03-25T12:00:00.000Z');

      const boundaries = getFullyElapsedMonthBoundaries(earliest, now);
      expect(boundaries).toEqual([]);
    });
  });

  describe('2. Core computeMetricBaseline with explicit asOf parameter', () => {
    test('computes baseline statistics strictly within [asOf - windowDays, asOf]', async () => {
      const asOf = new Date('2026-03-01T00:00:00.000Z');
      
      // Insert 12 points before asOf (inside 90-day window: Jan/Feb 2026)
      const validEntries = [];
      for (let i = 1; i <= 12; i++) {
        validEntries.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'morning-weight-kg',
          startTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T08:00:00.000Z`),
          endTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T08:00:00.000Z`),
          valueNumeric: 70 + i,
        });
      }

      // Insert 5 points AFTER asOf (March 2026) - should be excluded from this asOf snapshot
      for (let i = 2; i <= 6; i++) {
        validEntries.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'morning-weight-kg',
          startTime: new Date(`2026-03-${i.toString().padStart(2, '0')}T08:00:00.000Z`),
          endTime: new Date(`2026-03-${i.toString().padStart(2, '0')}T08:00:00.000Z`),
          valueNumeric: 95,
        });
      }

      await db.insert(metricEntries).values(validEntries);

      const result = await computeMetricBaseline(testUserId, 'morning-weight-kg', {
        windowDays: BASELINE_HISTORY_WINDOW_DAYS,
        asOf,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sampleSize).toBe(12);
        expect(result.min).toBe(71);
        expect(result.max).toBe(82);
        expect(result.mean).toBe(76.5);
      }
    });

    test('existing live getMetricBaseline defaults to now without changing behavior', async () => {
      const now = new Date();
      const recentEntries = [];
      for (let i = 1; i <= 12; i++) {
        const entryTime = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        recentEntries.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'morning-weight-kg',
          startTime: entryTime,
          endTime: entryTime,
          valueNumeric: 75 + i * 0.2,
        });
      }
      await db.insert(metricEntries).values(recentEntries);

      const live = await getMetricBaseline(testUserId, 'morning-weight-kg');
      expect(live.ok).toBe(true);
      if (live.ok) {
        expect(live.sampleSize).toBeGreaterThanOrEqual(12);
        expect(live.mean).toBeGreaterThan(70);
      }
    });
  });

  describe('3. Batch refreshBaselineHistory', () => {
    test('full backfill from zero existing rows inserts all eligible snapshots', async () => {
      const fixedNow = new Date('2026-03-20T00:00:00.000Z');
      const summary = await refreshBaselineHistory(testUserId, { now: fixedNow });

      expect(summary.metricsProcessed).toBeGreaterThanOrEqual(1);
      expect(summary.snapshotsAdded).toBeGreaterThanOrEqual(1);
      expect(summary.snapshotsSkippedExisting).toBe(0);
    });

    test('idempotent second refresh adds zero new rows and reports all as skipped existing', async () => {
      const fixedNow = new Date('2026-03-20T00:00:00.000Z');
      const summary = await refreshBaselineHistory(testUserId, { now: fixedNow });

      expect(summary.snapshotsAdded).toBe(0);
      expect(summary.snapshotsSkippedExisting).toBeGreaterThanOrEqual(1);
    });

    test('silently skips boolean and category metrics without throwing ValidationError', async () => {
      // Insert boolean entry
      await db.insert(metricEntries).values({
        userId: testUserId,
        provider: 'manual',
        metricType: 'took-medication',
        startTime: new Date('2026-01-05T08:00:00.000Z'),
        endTime: new Date('2026-01-05T08:00:00.000Z'),
        valueNumeric: 1,
      });

      const fixedNow = new Date('2026-03-20T00:00:00.000Z');
      const summary = await refreshBaselineHistory(testUserId, { now: fixedNow });

      expect(summary.metricsSkippedNonApplicable.some((m) => m.metricType === 'took-medication')).toBe(true);
      const skippedItem = summary.metricsSkippedNonApplicable.find((m) => m.metricType === 'took-medication');
      expect(skippedItem?.reason).toBe('non_applicable_type');
      expect(skippedItem?.valueType).toBe('boolean');
    });

    test('respects maxSnapshots cap per request and sets hasMore = true', async () => {
      const fixedNow = new Date('2026-03-20T00:00:00.000Z');
      const summary = await refreshBaselineHistory(testUserId, { maxSnapshots: 0, now: fixedNow });
      expect(summary.hasMore).toBe(true);
      expect(summary.snapshotsAdded).toBe(0);
    });

    test('gap month with insufficient data leaves no row while surrounding months succeed', async () => {
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: 'hydration-test-liters',
        displayName: 'Hydration Test',
        valueType: 'numeric',
        unit: 'L',
      });

      // Insert 12 entries in Jan 2025
      const janPoints = [];
      for (let i = 1; i <= 12; i++) {
        janPoints.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'hydration-test-liters',
          startTime: new Date(`2025-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          endTime: new Date(`2025-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          valueNumeric: 2.5,
        });
      }
      // Insert only 2 entries in May 2025 (months March, April, May, June have gap)
      const mayPoints = [
        {
          userId: testUserId,
          provider: 'manual',
          metricType: 'hydration-test-liters',
          startTime: new Date('2025-05-10T10:00:00.000Z'),
          endTime: new Date('2025-05-10T10:00:00.000Z'),
          valueNumeric: 2.0,
        },
        {
          userId: testUserId,
          provider: 'manual',
          metricType: 'hydration-test-liters',
          startTime: new Date('2025-05-11T10:00:00.000Z'),
          endTime: new Date('2025-05-11T10:00:00.000Z'),
          valueNumeric: 2.0,
        },
      ];

      await db.insert(metricEntries).values([...janPoints, ...mayPoints]);

      const fixedNow = new Date('2025-08-15T00:00:00.000Z');
      const summary = await refreshBaselineHistory(testUserId, { now: fixedNow });

      expect(summary.snapshotsSkippedInsufficientData).toBeGreaterThan(0);

      const history = await getMetricBaselineHistory(testUserId, 'hydration-test-liters');
      
      // 2025-02-01 (window Nov 2024 - Jan 2025) has Jan 12 points -> succeeded
      expect(history.some((h) => h.computedAt.startsWith('2025-02-01'))).toBe(true);

      // 2025-07-01 (window April 2025 - June 2025) has only 2 May points -> NO row
      expect(history.some((h) => h.computedAt.startsWith('2025-07-01'))).toBe(false);
    });

    test('simulated concurrent double-refresh safely exercises unique constraint with ON CONFLICT DO NOTHING', async () => {
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: 'concurrent-test-metric',
        displayName: 'Concurrent Test',
        valueType: 'numeric',
      });

      const points = [];
      for (let i = 1; i <= 15; i++) {
        points.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'concurrent-test-metric',
          startTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          endTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          valueNumeric: 100 + i,
        });
      }
      await db.insert(metricEntries).values(points);

      const fixedNow = new Date('2026-03-20T00:00:00.000Z');

      // Run two parallel refreshes concurrently
      const [res1, res2] = await Promise.all([
        refreshBaselineHistory(testUserId, { now: fixedNow }),
        refreshBaselineHistory(testUserId, { now: fixedNow }),
      ]);

      const history = await getMetricBaselineHistory(testUserId, 'concurrent-test-metric');
      const computedAtSet = new Set(history.map((h) => h.computedAt));
      
      // 1. Strict uniqueness guarantee in DB
      expect(computedAtSet.size).toBe(history.length);
      expect(history.length).toBeGreaterThanOrEqual(1);

      // 2. Exact match: sum of reported snapshotsAdded across both concurrent executions equals exact rows created
      expect(res1.snapshotsAdded + res2.snapshotsAdded).toBe(history.length);
    });

    test('refreshBaselineHistory with metricType option targets only the specified metric', async () => {
      await db.insert(metricDefinitions).values({
        userId: testUserId,
        metricType: 'targeted-refresh-metric',
        displayName: 'Targeted Metric',
        valueType: 'numeric',
      });

      const points = [];
      for (let i = 1; i <= 15; i++) {
        points.push({
          userId: testUserId,
          provider: 'manual',
          metricType: 'targeted-refresh-metric',
          startTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          endTime: new Date(`2026-01-${i.toString().padStart(2, '0')}T10:00:00.000Z`),
          valueNumeric: 200 + i,
        });
      }
      await db.insert(metricEntries).values(points);

      const summary = await refreshBaselineHistory(testUserId, {
        metricType: 'targeted-refresh-metric',
        now: new Date('2026-03-20T00:00:00.000Z'),
      });

      expect(summary.metricsProcessed).toBe(1);
      expect(summary.snapshotsAdded).toBeGreaterThanOrEqual(1);

      const history = await getMetricBaselineHistory(testUserId, 'targeted-refresh-metric');
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].metricType).toBe('targeted-refresh-metric');
    });

  });

  describe('4. getMetricBaselineHistory query', () => {
    test('returns chronological snapshots for user and metric with range filtering', async () => {
      const allHistory = await getMetricBaselineHistory(testUserId, 'morning-weight-kg');
      expect(Array.isArray(allHistory)).toBe(true);
      expect(allHistory.length).toBeGreaterThan(0);

      // Chronological order verification
      for (let i = 1; i < allHistory.length; i++) {
        expect(new Date(allHistory[i].computedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(allHistory[i - 1].computedAt).getTime()
        );
      }

      // Range filtering
      const filtered = await getMetricBaselineHistory(testUserId, 'morning-weight-kg', {
        startTime: new Date('2026-02-01T00:00:00.000Z'),
        endTime: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect(filtered.every((h) => h.computedAt >= '2026-02-01' && h.computedAt <= '2026-03-01T23:59:59Z')).toBe(true);
    });
  });
});
