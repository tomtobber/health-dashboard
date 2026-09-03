import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { LineChart, Line, XAxis, YAxis } from 'recharts';
import { buildChartTimelineData } from '../client/src/utils/timeScale';
import { EnrichedMetricQueryResult } from '../client/src/types';

describe('MultiMetricPanel Recharts Real SVG Rendering & Time-Scaled Coordinates', () => {
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
          startTime: '2026-08-01T00:00:00.000Z',
          endTime: '2026-08-01T23:59:59.000Z',
          valueNumeric: 62,
          unit: 'bpm',
          dimension: 'default',
          aggregation: 'daily_avg',
        },
        {
          userId: 'u1',
          provider: 'google_health',
          metricType: 'daily-resting-heart-rate',
          startTime: '2026-08-02T00:00:00.000Z',
          endTime: '2026-08-02T23:59:59.000Z',
          valueNumeric: 64,
          unit: 'bpm',
          dimension: 'default',
          aggregation: 'daily_avg',
        },
        {
          userId: 'u1',
          provider: 'google_health',
          metricType: 'daily-resting-heart-rate',
          startTime: '2026-08-03T00:00:00.000Z',
          endTime: '2026-08-03T23:59:59.000Z',
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
          startTime: '2026-08-07T08:00:00.000Z',
          endTime: '2026-08-07T08:05:00.000Z',
          valueNumeric: 78.5,
          unit: 'kg',
          dimension: 'default',
          aggregation: 'raw',
        },
        {
          userId: 'u1',
          provider: 'manual',
          metricType: 'weight',
          startTime: '2026-08-14T08:00:00.000Z',
          endTime: '2026-08-14T08:05:00.000Z',
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

  test('Recharts renders SVG circle elements with real coordinates strictly proportional to elapsed time (1.75x ratio)', () => {
    const timeline = buildChartTimelineData(mockDataset, true);

    // Render real Recharts LineChart configured identically to MultiMetricPanel.tsx
    const chartElement = React.createElement(
      LineChart,
      {
        width: 600,
        height: 400,
        data: timeline,
        margin: { top: 10, right: 30, left: 10, bottom: 20 },
      },
      React.createElement(XAxis as React.ElementType, {
        dataKey: 'timestamp',
        type: 'number',
        scale: 'time',
        domain: ['dataMin', 'dataMax'],
      }),
      React.createElement(YAxis as React.ElementType, {
        yAxisId: 'daily-resting-heart-rate',
        domain: ['auto', 'auto'],
      }),
      React.createElement(YAxis as React.ElementType, {
        yAxisId: 'weight',
        domain: ['auto', 'auto'],
        orientation: 'right',
      }),
      React.createElement(Line as React.ElementType, {
        key: 'daily-resting-heart-rate',
        yAxisId: 'daily-resting-heart-rate',
        dataKey: 'daily-resting-heart-rate',
        dot: { r: 2 },
      }),
      React.createElement(Line as React.ElementType, {
        key: 'weight',
        yAxisId: 'weight',
        dataKey: 'weight',
        dot: { r: 2 },
      })
    );

    const svgMarkup = ReactDOMServer.renderToStaticMarkup(chartElement);

    // Extract all rendered circle elements (<circle ... cx="..." cy="..." />)
    const circleMatches = [...svgMarkup.matchAll(/<circle[^>]*cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*>/g)];
    const renderedPoints = circleMatches.map((m) => ({
      cx: parseFloat(m[1]),
      cy: parseFloat(m[2]),
    }));

    // Expect exactly 5 rendered dots (3 for heart-rate + 2 for weight)
    expect(renderedPoints).toHaveLength(5);

    const [pDay1, pDay2, pDay3, pDay7, pDay14] = renderedPoints;

    // 1. Strict Monotonicity: coordinates must strictly increase along X-axis
    expect(pDay1.cx).toBeLessThan(pDay2.cx);
    expect(pDay2.cx).toBeLessThan(pDay3.cx);
    expect(pDay3.cx).toBeLessThan(pDay7.cx);
    expect(pDay7.cx).toBeLessThan(pDay14.cx);

    // 2. Uniform 1-day spacing in real rendered coordinates
    const dDay1to2 = pDay2.cx - pDay1.cx;
    const dDay2to3 = pDay3.cx - pDay2.cx;
    expect(dDay1to2).toBeCloseTo(dDay2to3, 4);

    // 3. Proportional gap spacing in real rendered SVG coordinates
    const dDay3to7 = pDay7.cx - pDay3.cx;   // 4 days gap
    const dDay7to14 = pDay14.cx - pDay7.cx; // 7 days gap

    expect(dDay3to7 / dDay1to2).toBeCloseTo(4.0, 3);
    expect(dDay7to14 / dDay1to2).toBeCloseTo(7.0, 3);

    // 4. The critical ratio test directly on REAL rendered SVG coordinates:
    // Gap between Metric B's points (Day 7 -> 14) / Gap between Metric A & B (Day 3 -> 7) = 7/4 = 1.75
    const renderedRatio = dDay7to14 / dDay3to7;
    expect(renderedRatio).toBeCloseTo(1.75, 4);

    // Verify it is NOT the broken categorical ratio (1.00)
    expect(renderedRatio).not.toBeCloseTo(1.0, 1);
  });
  test('aggregates multiple intra-day interval steps entries into steps per day', () => {
    const stepsDataset: EnrichedMetricQueryResult[] = [
      {
        metricType: 'steps',
        displayName: 'Steps',
        valueType: 'numeric',
        unit: 'count',
        categoryValues: null,
        isCustom: false,
        isArchived: false,
        entries: [
          // Day 1: 3 entries totaling 10,000 steps
          {
            userId: 'u1',
            provider: 'google_health',
            metricType: 'steps',
            startTime: '2026-08-01T08:00:00.000Z',
            endTime: '2026-08-01T08:30:00.000Z',
            valueNumeric: 3000,
            unit: 'count',
          },
          {
            userId: 'u1',
            provider: 'google_health',
            metricType: 'steps',
            startTime: '2026-08-01T12:00:00.000Z',
            endTime: '2026-08-01T12:45:00.000Z',
            valueNumeric: 4000,
            unit: 'count',
          },
          {
            userId: 'u1',
            provider: 'google_health',
            metricType: 'steps',
            startTime: '2026-08-01T18:00:00.000Z',
            endTime: '2026-08-01T18:30:00.000Z',
            valueNumeric: 3000,
            unit: 'count',
          },
          // Day 2: 2 entries totaling 8,500 steps
          {
            userId: 'u1',
            provider: 'google_health',
            metricType: 'steps',
            startTime: '2026-08-02T09:00:00.000Z',
            endTime: '2026-08-02T09:30:00.000Z',
            valueNumeric: 3500,
            unit: 'count',
          },
          {
            userId: 'u1',
            provider: 'google_health',
            metricType: 'steps',
            startTime: '2026-08-02T15:00:00.000Z',
            endTime: '2026-08-02T16:00:00.000Z',
            valueNumeric: 5000,
            unit: 'count',
          },
        ],
      },
    ];

    const timeline = buildChartTimelineData(stepsDataset, true);

    expect(timeline).toHaveLength(2);
    expect(timeline[0].time).toBe('2026-08-01');
    expect(timeline[0]['steps']).toBe(10000);

    expect(timeline[1].time).toBe('2026-08-02');
    expect(timeline[1]['steps']).toBe(8500);
  });
});
