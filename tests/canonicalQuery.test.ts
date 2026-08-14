import { describe, test, expect } from '@jest/globals';
import { filterReconciledOverRaw, MetricEntryWithDelete } from '../src/services/metricsQueryService';

describe('Canonical Query Reconciled-Preferred Deduplication', () => {
  const userId = 'user_canonical_123';
  const t1 = new Date('2026-08-10T10:00:00Z');
  const t2 = new Date('2026-08-10T10:05:00Z');
  const t3 = new Date('2026-08-10T10:10:00Z');
  const t4 = new Date('2026-08-10T10:15:00Z');

  test('Reconciled stream takes precedence over raw stream for the same interval', () => {
    const mixedEntries: MetricEntryWithDelete[] = [
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: 'raw_pt_1',
        startTime: t1,
        endTime: t2,
        valueNumeric: 250,
        unit: 'count',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        startTime: t1,
        endTime: t2,
        valueNumeric: 300, // Reconciled higher accuracy value
        unit: 'count',
        sourceStream: 'reconciled',
        aggregation: '5m_rollup',
      },
    ];

    const result = filterReconciledOverRaw(mixedEntries);
    expect(result).toHaveLength(1);
    expect(result[0].sourceStream).toBe('reconciled');
    expect(result[0].valueNumeric).toBe(300);
  });

  test('Raw stream fills gaps where no reconciled stream exists for that interval', () => {
    const mixedEntries: MetricEntryWithDelete[] = [
      // Interval 1: Reconciled exists
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        startTime: t1,
        endTime: t2,
        valueNumeric: 300,
        unit: 'count',
        sourceStream: 'reconciled',
        aggregation: '5m_rollup',
      },
      // Interval 2: Only raw exists
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: 'raw_pt_2',
        startTime: t3,
        endTime: t4,
        valueNumeric: 150,
        unit: 'count',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
    ];

    const result = filterReconciledOverRaw(mixedEntries);
    expect(result).toHaveLength(2);
    expect(result[0].startTime).toEqual(t1);
    expect(result[0].sourceStream).toBe('reconciled');
    expect(result[1].startTime).toEqual(t3);
    expect(result[1].sourceStream).toBe('raw');
  });

  test('Soft-deleted records (deletedAt is set) are excluded from the canonical read path', () => {
    const mixedEntries: MetricEntryWithDelete[] = [
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: 'raw_pt_deleted',
        startTime: t1,
        endTime: t2,
        valueNumeric: 500,
        unit: 'count',
        sourceStream: 'raw',
        aggregation: 'raw',
        deletedAt: new Date('2026-08-11T00:00:00Z'), // Soft-deleted
      },
      {
        userId,
        provider: 'google_health',
        metricType: 'steps',
        externalId: 'raw_pt_active',
        startTime: t3,
        endTime: t4,
        valueNumeric: 200,
        unit: 'count',
        sourceStream: 'raw',
        aggregation: 'raw',
        deletedAt: null,
      },
    ];

    const result = filterReconciledOverRaw(mixedEntries);
    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe('raw_pt_active');
  });
});
