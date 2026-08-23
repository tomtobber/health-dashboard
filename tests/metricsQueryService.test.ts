import {
  filterReconciledOverRaw,
  queryBatchEnrichedMetrics,
  queryEnrichedMetricEntries,
  queryMetricEntriesFromDb,
} from '../src/services/metricsQueryService';
import { NormalizedMetricEntry } from '../src/adapters/baseAdapter';
import { db, pool } from '../src/db';
import { users, metricEntries } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Metrics Canonical Query Path & SQL Daily Aggregation', () => {
  let testUserId: string;

  beforeAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', ['query_service_tester@example.com']).catch(() => {});

    const [user] = await db
      .insert(users)
      .values({
        email: 'query_service_tester@example.com',
        passwordHash: 'hashed_secret_test',
      })
      .returning();

    testUserId = user.id;

    // Seed mock high-frequency heart rate entries across 3 distinct days:
    // Day 1: 2026-08-01 (10 entries: 5 at 60 bpm, 5 at 80 bpm -> Expected Daily Avg: 70 bpm)
    // Day 2: 2026-08-02 (4 entries: 4 at 100 bpm -> Expected Daily Avg: 100 bpm)
    // Day 3: 2026-08-03 (6 entries: 3 at 50 bpm, 3 at 90 bpm -> Expected Daily Avg: 70 bpm)
    const hrEntries = [];
    for (let i = 0; i < 5; i++) {
      hrEntries.push({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'heart-rate',
        startTime: new Date(`2026-08-01T10:0${i}:00Z`),
        endTime: new Date(`2026-08-01T10:0${i + 1}:00Z`),
        valueNumeric: 60,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: '1m_avg',
      });
      hrEntries.push({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'heart-rate',
        startTime: new Date(`2026-08-01T11:0${i}:00Z`),
        endTime: new Date(`2026-08-01T11:0${i + 1}:00Z`),
        valueNumeric: 80,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: '1m_avg',
      });
    }

    for (let i = 0; i < 4; i++) {
      hrEntries.push({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'heart-rate',
        startTime: new Date(`2026-08-02T14:0${i}:00Z`),
        endTime: new Date(`2026-08-02T14:0${i + 1}:00Z`),
        valueNumeric: 100,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: '5m_avg',
      });
    }

    for (let i = 0; i < 3; i++) {
      hrEntries.push({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'heart-rate',
        startTime: new Date(`2026-08-03T08:0${i}:00Z`),
        endTime: new Date(`2026-08-03T08:0${i + 1}:00Z`),
        valueNumeric: 50,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: '1m_avg',
      });
      hrEntries.push({
        userId: testUserId,
        provider: 'google_health',
        metricType: 'heart-rate',
        startTime: new Date(`2026-08-03T09:0${i}:00Z`),
        endTime: new Date(`2026-08-03T09:0${i + 1}:00Z`),
        valueNumeric: 90,
        unit: 'bpm',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: '1m_avg',
      });
    }

    await db.insert(metricEntries).values(hrEntries);

    // Seed steps entries on Day 1 & Day 2 (cumulative metric)
    await db.insert(metricEntries).values([
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'steps',
        startTime: new Date('2026-08-01T09:00:00Z'),
        endTime: new Date('2026-08-01T10:00:00Z'),
        valueNumeric: 3000,
        unit: 'count',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'steps',
        startTime: new Date('2026-08-01T14:00:00Z'),
        endTime: new Date('2026-08-01T15:00:00Z'),
        valueNumeric: 4500,
        unit: 'count',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'steps',
        startTime: new Date('2026-08-02T12:00:00Z'),
        endTime: new Date('2026-08-02T13:00:00Z'),
        valueNumeric: 8000,
        unit: 'count',
        dimension: 'default',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
    ]);

    // Seed sleep entry with summary and stage breakdowns on Day 1
    await db.insert(metricEntries).values([
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'sleep',
        startTime: new Date('2026-08-01T22:00:00Z'),
        endTime: new Date('2026-08-02T06:00:00Z'),
        valueNumeric: 480, // 8 hours total
        unit: 'minutes',
        dimension: 'summary',
        sourceStream: 'reconciled',
        aggregation: 'raw',
      },
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'sleep',
        startTime: new Date('2026-08-01T22:00:00Z'),
        endTime: new Date('2026-08-02T00:00:00Z'),
        valueNumeric: 120,
        unit: 'minutes',
        dimension: 'deep',
        sourceStream: 'reconciled',
        aggregation: 'raw',
      },
      {
        userId: testUserId,
        provider: 'google_health',
        metricType: 'sleep',
        startTime: new Date('2026-08-02T00:00:00Z'),
        endTime: new Date('2026-08-02T06:00:00Z'),
        valueNumeric: 360,
        unit: 'minutes',
        dimension: 'light',
        sourceStream: 'reconciled',
        aggregation: 'raw',
      },
    ]);
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(metricEntries).where(eq(metricEntries.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

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
      valueNumeric: 70,
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

  test('SQL daily_avg aggregation returns 1 row per day (3 rows total, not 20 raw rows)', async () => {
    const startRange = new Date('2026-08-01T00:00:00Z');
    const endRange = new Date('2026-08-04T00:00:00Z');

    const batchResults = await queryBatchEnrichedMetrics({
      userId: testUserId,
      metricTypes: ['heart-rate'],
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    expect(batchResults).toHaveLength(1);
    const hrResult = batchResults[0];
    expect(hrResult.metricType).toBe('heart-rate');
    expect(hrResult.entries).toHaveLength(3); // Exactly 3 days, not 20 underlying rows!

    expect(hrResult.entries[0].valueNumeric).toBe(70); // (5*60 + 5*80) / 10 = 70
    expect(hrResult.entries[1].valueNumeric).toBe(100); // (4*100) / 4 = 100
    expect(hrResult.entries[2].valueNumeric).toBe(70); // (3*50 + 3*90) / 6 = 70
  });

  test('queryBatchEnrichedMetrics and queryEnrichedMetricEntries and queryMetricEntriesFromDb return identical daily values', async () => {
    const startRange = new Date('2026-08-01T00:00:00Z');
    const endRange = new Date('2026-08-04T00:00:00Z');

    const [batchRes] = await queryBatchEnrichedMetrics({
      userId: testUserId,
      metricTypes: ['heart-rate'],
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    const singleRes = await queryEnrichedMetricEntries({
      userId: testUserId,
      metricType: 'heart-rate',
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    const dbEntries = await queryMetricEntriesFromDb({
      userId: testUserId,
      metricType: 'heart-rate',
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    expect(batchRes.entries).toHaveLength(3);
    expect(singleRes.entries).toHaveLength(3);
    expect(dbEntries).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      expect(singleRes.entries[i].valueNumeric).toBe(batchRes.entries[i].valueNumeric);
      expect(dbEntries[i].valueNumeric).toBe(batchRes.entries[i].valueNumeric);
      expect(singleRes.entries[i].startTime.toISOString().split('T')[0]).toBe(
        batchRes.entries[i].startTime.toISOString().split('T')[0]
      );
    }
  });

  test('Cumulative metric (steps) computes daily sum in SQL', async () => {
    const startRange = new Date('2026-08-01T00:00:00Z');
    const endRange = new Date('2026-08-04T00:00:00Z');

    const [stepsRes] = await queryBatchEnrichedMetrics({
      userId: testUserId,
      metricTypes: ['steps'],
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    expect(stepsRes.entries).toHaveLength(2); // Day 1 & Day 2
    expect(stepsRes.entries[0].valueNumeric).toBe(7500); // 3000 + 4500 = 7500
    expect(stepsRes.entries[1].valueNumeric).toBe(8000);
  });

  test('Sleep metric only aggregates summary dimension without double counting stages', async () => {
    const startRange = new Date('2026-08-01T00:00:00Z');
    const endRange = new Date('2026-08-04T00:00:00Z');

    const [sleepRes] = await queryBatchEnrichedMetrics({
      userId: testUserId,
      metricTypes: ['sleep'],
      startTime: startRange,
      endTime: endRange,
      aggregation: 'daily_avg',
    });

    expect(sleepRes.entries).toHaveLength(1);
    expect(sleepRes.entries[0].valueNumeric).toBe(480); // 480 minutes (8h), NOT 480 + 120 + 360 = 960!
  });
});
