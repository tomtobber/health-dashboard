import { downsampleEntries } from '../src/services/downsamplingService';
import { NormalizedMetricEntry } from '../src/adapters/baseAdapter';

describe('downsamplingService', () => {
  test('returns empty array when given empty input', () => {
    expect(downsampleEntries([])).toEqual([]);
  });

  test('preserves low-frequency standard metrics without aggregation', () => {
    const sample: NormalizedMetricEntry = {
      userId: 'user_123',
      provider: 'google_health',
      metricType: 'steps',
      externalId: 'ext_steps_1',
      startTime: new Date('2026-08-13T10:00:00Z'),
      endTime: new Date('2026-08-13T10:05:00Z'),
      valueNumeric: 500,
      unit: 'count',
      sourceStream: 'reconciled',
      aggregation: 'raw',
    };
    const result = downsampleEntries([sample]);
    expect(result).toHaveLength(1);
    expect(result[0].metricType).toBe('steps');
    expect(result[0].aggregation).toBe('raw');
    expect(result[0].valueNumeric).toBe(500);
  });

  test('aggregates 5-second heart rate samples into 1-minute averaged buckets', () => {
    const entries: NormalizedMetricEntry[] = [
      {
        userId: 'user_123',
        provider: 'google_health',
        metricType: 'heart_rate',
        externalId: 'ext_hr_1',
        startTime: new Date('2026-08-13T10:00:05Z'),
        endTime: new Date('2026-08-13T10:00:10Z'),
        valueNumeric: 70,
        unit: 'bpm',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
      {
        userId: 'user_123',
        provider: 'google_health',
        metricType: 'heart_rate',
        externalId: 'ext_hr_2',
        startTime: new Date('2026-08-13T10:00:30Z'),
        endTime: new Date('2026-08-13T10:00:35Z'),
        valueNumeric: 80,
        unit: 'bpm',
        sourceStream: 'raw',
        aggregation: 'raw',
      },
    ];

    const result = downsampleEntries(entries, 1);
    expect(result).toHaveLength(1);
    expect(result[0].metricType).toBe('heart_rate');
    expect(result[0].aggregation).toBe('1m_avg');
    expect(result[0].valueNumeric).toBe(75); // (70 + 80) / 2
    expect(result[0].startTime).toEqual(new Date('2026-08-13T10:00:00.000Z'));
    expect(result[0].endTime).toEqual(new Date('2026-08-13T10:01:00.000Z'));
    expect(result[0].rawPayload).toHaveProperty('samplesCount', 2);
  });
});
