import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries, metricBaselineHistory } from '../src/db/schema';
import {
  refreshBaselineHistory,
  getMetricBaselineHistory,
  getFullyElapsedMonthBoundaries,
  BASELINE_HISTORY_WINDOW_DAYS,
  MIN_BASELINE_HISTORY_SAMPLE_SIZE,
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
      // Seed 12 entries within the trailing 30 days of real 'now'
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
    test('skips boolean/category metrics silently without throwing, inserts snapshots, and is idempotent', async () => {
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
      const summary1 = await refreshBaselineHistory(testUserId, { now: fixedNow });

      expect(summary1.metricsProcessed).toBeGreaterThanOrEqual(1);
      expect(summary1.snapshotsAdded).toBeGreaterThanOrEqual(1);
      expect(summary1.metricsSkippedNonApplicable.some((m) => m.metricType === 'took-medication')).toBe(true);

      // Second run is idempotent: 0 added, all skipped as existing
      const summary2 = await refreshBaselineHistory(testUserId, { now: fixedNow });
      expect(summary2.snapshotsAdded).toBe(0);
      expect(summary2.snapshotsSkippedExisting).toBeGreaterThanOrEqual(1);
    });

    test('respects maxSnapshots cap per request and sets hasMore = true', async () => {
      const fixedNow = new Date('2026-03-20T00:00:00.000Z');
      // Setting maxSnapshots = 0 should immediately return hasMore = true
      const summary = await refreshBaselineHistory(testUserId, { maxSnapshots: 0, now: fixedNow });
      expect(summary.hasMore).toBe(true);
      expect(summary.snapshotsAdded).toBe(0);
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
