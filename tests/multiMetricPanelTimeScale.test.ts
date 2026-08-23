import {
  buildChartTimelineData,
  computeTimeScaledX,
} from '../client/src/utils/timeScale';
import { EnrichedMetricQueryResult } from '../client/src/types';

describe('MultiMetricPanel Time-Scaled XAxis Coordinate Rendering', () => {
  // Mock dataset:
  // Metric A (daily-resting-heart-rate): dense daily points on Day 1, Day 2, Day 3
  // Metric B (weight): sparse weekly points on Day 7 and Day 14
  const mockDataset: EnrichedMetricQueryResult[] = [
    {
      metricType: 'daily-resting-heart-rate',
      displayName: 'Resting Heart Rate',
      valueType: 'numeric',
      unit: 'bpm',
      categoryValues: null,
      isCustom: false,
      isArchived: false,
      entries: [
        {
          userId: 'u1',
          provider: 'google_health',
          metricType: 'daily-resting-heart-rate',
          startTime: '2026-08-01T00:00:00.000Z' as any,
          endTime: '2026-08-01T23:59:59.000Z' as any,
          valueNumeric: 62,
          unit: 'bpm',
          dimension: 'default',
          aggregation: 'daily_avg',
        },
        {
          userId: 'u1',
          provider: 'google_health',
          metricType: 'daily-resting-heart-rate',
          startTime: '2026-08-02T00:00:00.000Z' as any,
          endTime: '2026-08-02T23:59:59.000Z' as any,
          valueNumeric: 64,
          unit: 'bpm',
          dimension: 'default',
          aggregation: 'daily_avg',
        },
        {
          userId: 'u1',
          provider: 'google_health',
          metricType: 'daily-resting-heart-rate',
          startTime: '2026-08-03T00:00:00.000Z' as any,
          endTime: '2026-08-03T23:59:59.000Z' as any,
          valueNumeric: 61,
          unit: 'bpm',
          dimension: 'default',
          aggregation: 'daily_avg',
        },
      ],
    },
    {
      metricType: 'weight',
      displayName: 'Body Weight',
      valueType: 'numeric',
      unit: 'kg',
      categoryValues: null,
      isCustom: false,
      isArchived: false,
      entries: [
        {
          userId: 'u1',
          provider: 'manual',
          metricType: 'weight',
          startTime: '2026-08-07T08:00:00.000Z' as any,
          endTime: '2026-08-07T08:05:00.000Z' as any,
          valueNumeric: 78.5,
          unit: 'kg',
          dimension: 'default',
          aggregation: 'raw',
        },
        {
          userId: 'u1',
          provider: 'manual',
          metricType: 'weight',
          startTime: '2026-08-14T08:00:00.000Z' as any,
          endTime: '2026-08-14T08:05:00.000Z' as any,
          valueNumeric: 77.9,
          unit: 'kg',
          dimension: 'default',
          aggregation: 'raw',
        },
      ],
    },
  ];

  test('buildChartTimelineData aligns disparate series into unified chronological timeline with epoch timestamps', () => {
    const timeline = buildChartTimelineData(mockDataset, true);

    expect(timeline).toHaveLength(5);
    // Chronological order: Day 1 -> Day 2 -> Day 3 -> Day 7 -> Day 14
    expect(timeline[0].time).toBe('2026-08-01');
    expect(timeline[0]['daily-resting-heart-rate']).toBe(62);
    expect(timeline[0]['weight']).toBeUndefined();

    expect(timeline[1].time).toBe('2026-08-02');
    expect(timeline[1]['daily-resting-heart-rate']).toBe(64);

    expect(timeline[2].time).toBe('2026-08-03');
    expect(timeline[2]['daily-resting-heart-rate']).toBe(61);

    expect(timeline[3].time).toBe('2026-08-07');
    expect(timeline[3]['weight']).toBe(78.5);
    expect(timeline[3]['daily-resting-heart-rate']).toBeUndefined();

    expect(timeline[4].time).toBe('2026-08-14');
    expect(timeline[4]['weight']).toBe(77.9);
    expect(timeline[4]['daily-resting-heart-rate']).toBeUndefined();
  });

  test('Rendered horizontal X-coordinates are strictly proportional to elapsed time (1.75x ratio between 7-day and 4-day gaps)', () => {
    const timeline = buildChartTimelineData(mockDataset, true);
    const minTs = timeline[0].timestamp; // Day 1
    const maxTs = timeline[timeline.length - 1].timestamp; // Day 14
    const plotWidth = 600; // Simulated 600px chart plot area
    const leftMargin = 30;

    // Calculate rendered x-coordinate for each data point
    const xDay1 = computeTimeScaledX(timeline[0].timestamp, minTs, maxTs, plotWidth, leftMargin);
    const xDay2 = computeTimeScaledX(timeline[1].timestamp, minTs, maxTs, plotWidth, leftMargin);
    const xDay3 = computeTimeScaledX(timeline[2].timestamp, minTs, maxTs, plotWidth, leftMargin);
    const xDay7 = computeTimeScaledX(timeline[3].timestamp, minTs, maxTs, plotWidth, leftMargin);
    const xDay14 = computeTimeScaledX(timeline[4].timestamp, minTs, maxTs, plotWidth, leftMargin);

    // 1. Strict monotonicity: x coordinates must strictly increase
    expect(xDay1).toBeLessThan(xDay2);
    expect(xDay2).toBeLessThan(xDay3);
    expect(xDay3).toBeLessThan(xDay7);
    expect(xDay7).toBeLessThan(xDay14);

    // 2. Proportional distance check:
    // Gap 1: Day 1 to Day 2 (1 day)
    const dDay1to2 = xDay2 - xDay1;
    // Gap 2: Day 2 to Day 3 (1 day)
    const dDay2to3 = xDay3 - xDay2;
    // Gap 3: Day 3 to Day 7 (4 days)
    const dDay3to7 = xDay7 - xDay3;
    // Gap 4: Day 7 to Day 14 (7 days)
    const dDay7to14 = xDay14 - xDay7;

    // Consecutive 1-day gaps must occupy identical pixel widths
    expect(dDay1to2).toBeCloseTo(dDay2to3, 4);

    // 4-day gap must be ~4x the width of a 1-day gap
    expect(dDay3to7 / dDay1to2).toBeCloseTo(4.0, 3);

    // 7-day gap must be ~7x the width of a 1-day gap
    expect(dDay7to14 / dDay1to2).toBeCloseTo(7.0, 3);

    // The key test: The horizontal distance between Metric B's points (Day 7 -> 14, 7 days)
    // must be exactly 1.75x the horizontal distance between Metric A (Day 3) and Metric B (Day 7, 4 days)
    const renderedRatio = dDay7to14 / dDay3to7;
    expect(renderedRatio).toBeCloseTo(1.75, 4); // (7 days / 4 days = 1.75)

    // Contrast with the broken categorical/index-based scaling where:
    // Index(Day 3 -> Day 7) = 3 - 2 = 1 slot
    // Index(Day 7 -> Day 14) = 4 - 3 = 1 slot
    // Categorical ratio would have been 1.00 (broken!), whereas time scale is 1.75 (correct!).
    expect(renderedRatio).not.toBeCloseTo(1.0, 1);
  });
});
