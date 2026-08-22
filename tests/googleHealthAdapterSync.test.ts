import { GoogleHealthAdapter, splitDateRange, toKebabCase, toSnakeCase, buildAip160Filter } from '../src/adapters/googleHealthAdapter';
import { ExternalServiceError } from '../src/errors/AppError';

describe('GoogleHealthAdapter Sync & Range Splitting', () => {
  test('toKebabCase and toSnakeCase correctly convert metric names', () => {
    expect(toKebabCase('activeZoneMinutes')).toBe('active-zone-minutes');
    expect(toKebabCase('active_zone_minutes')).toBe('active-zone-minutes');
    expect(toKebabCase('heartRate')).toBe('heart-rate');
    expect(toKebabCase('runVo2Max')).toBe('run-vo2-max');
    expect(toKebabCase('steps')).toBe('steps');

    expect(toSnakeCase('active-zone-minutes')).toBe('active_zone_minutes');
    expect(toSnakeCase('activeZoneMinutes')).toBe('active_zone_minutes');
    expect(toSnakeCase('heart-rate')).toBe('heart_rate');
    expect(toSnakeCase('run-vo2-max')).toBe('run_vo2_max');
    expect(toSnakeCase('steps')).toBe('steps');
  });

  test('splitDateRange correctly splits date ranges beyond maximum days', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-30T00:00:00Z');
    const ranges = splitDateRange(start, end, 14);

    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].start).toEqual(start);
    const firstDiffDays = (ranges[0].end.getTime() - ranges[0].start.getTime()) / (1000 * 60 * 60 * 24);
    expect(firstDiffDays).toBeLessThanOrEqual(14);
  });

  test('sync method runs successfully and outputs mapped metric entries', async () => {
    const adapter = new GoogleHealthAdapter();
    const res = await adapter.sync({
      userId: 'test_user_id',
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-08-05T00:00:00Z'),
      metricTypes: ['steps', 'heart-rate'],
      accessToken: 'mock_access_token',
    });

    expect(res.status).toBe('completed');
    expect(res.pointsFetched).toBeGreaterThan(0);
    expect(res.mappedEntries).toBeDefined();
    expect(res.mappedEntries!.length).toBeGreaterThan(0);
    // Check skippedMetrics or mappedEntries status
    expect(res.status).toBe('completed');
  });

  test('mapToNormalizedSchema maps Google Health v4 DataPoint objects', () => {
    const adapter = new GoogleHealthAdapter();
    const v4DataPoint = {
      name: 'users/me/dataTypes/steps/dataPoints/sample_123',
      interval: {
        startTime: '2026-08-16T12:00:00.000Z',
        endTime: '2026-08-16T12:01:00.000Z',
      },
      steps: {
        count: 150,
      },
      userId: 'user_abc',
      metricType: 'steps',
    };

    const mapped = adapter.mapToNormalizedSchema(v4DataPoint);
    expect(mapped.length).toBe(1);
    expect(mapped[0].metricType).toBe('steps');
    expect(mapped[0].externalId).toBe('users/me/dataTypes/steps/dataPoints/sample_123');
    expect(mapped[0].valueNumeric).toBe(150);
    expect(mapped[0].unit).toBe('count');
    expect(mapped[0].startTime).toEqual(new Date('2026-08-16T12:00:00.000Z'));
  });

  test('refreshToken returns fresh accessToken and valid scopes', async () => {
    const adapter = new GoogleHealthAdapter();
    const res = await adapter.refreshToken('mock_refresh_token_xyz');

    expect(res).toBeDefined();
    expect(res.accessToken).toBeDefined();
    expect(res.accessToken).toContain('mock_refreshed_access_token');
    expect(res.expiresIn).toBe(3600);
    expect(res.scopes).toEqual(GoogleHealthAdapter.SCOPES);
  });

  test('ExternalServiceError carries upstreamStatusCode correctly', () => {
    const err = new ExternalServiceError('GoogleHealthAPI', 'Unauthorized', 401);
    expect(err.statusCode).toBe(502);
    expect(err.upstreamStatusCode).toBe(401);
    expect(err.serviceName).toBe('GoogleHealthAPI');
  });

  test('buildAip160Filter constructs correct filter expressions per metric type', () => {
    const start = new Date('2026-08-16T00:00:00Z');
    const end = new Date('2026-08-17T00:00:00Z');

    // Interval metric
    expect(buildAip160Filter('steps', start, end)).toBe(
      'steps.interval.start_time >= "2026-08-16T00:00:00.000Z" AND steps.interval.start_time < "2026-08-17T00:00:00.000Z"'
    );

    // Instantaneous / sample-time metric
    expect(buildAip160Filter('blood-pressure', start, end)).toBe(
      'blood_pressure.sample_time.physical_time >= "2026-08-16T00:00:00.000Z" AND blood_pressure.sample_time.physical_time < "2026-08-17T00:00:00.000Z"'
    );
    expect(buildAip160Filter('blood-glucose', start, end)).toBe(
      'blood_glucose.sample_time.physical_time >= "2026-08-16T00:00:00.000Z" AND blood_glucose.sample_time.physical_time < "2026-08-17T00:00:00.000Z"'
    );

    // Daily aggregate metric
    expect(buildAip160Filter('daily-resting-heart-rate', start, end)).toBe(
      'daily_resting_heart_rate.date >= "2026-08-16" AND daily_resting_heart_rate.date < "2026-08-18"'
    );

    // Session metrics (unfiltered)
    expect(buildAip160Filter('sleep', start, end)).toBeUndefined();
    expect(buildAip160Filter('exercise', start, end)).toBeUndefined();
  });

  test('mapToNormalizedSchema maps protobuf string numbers and nested interval/date structures', () => {
    const adapter = new GoogleHealthAdapter();

    // 1. Steps with string count and nested interval
    const stepPoint = {
      userId: 'user_1',
      metricType: 'steps',
      steps: {
        count: '98',
        interval: {
          startTime: '2026-08-17T19:04:00Z',
          endTime: '2026-08-17T19:05:00Z',
        },
      },
    };
    const mappedSteps = adapter.mapToNormalizedSchema(stepPoint);
    expect(mappedSteps[0].valueNumeric).toBe(98);
    expect(mappedSteps[0].unit).toBe('count');
    expect(mappedSteps[0].startTime).toEqual(new Date('2026-08-17T19:04:00Z'));
    expect(mappedSteps[0].endTime).toEqual(new Date('2026-08-17T19:05:00Z'));
    expect(mappedSteps[0].externalId).toBe('gh_steps_' + new Date('2026-08-17T19:04:00Z').getTime());

    // 2. Heart rate with string beatsPerMinute and sampleTime
    const hrPoint = {
      userId: 'user_1',
      metricType: 'heart-rate',
      heartRate: {
        beatsPerMinute: '66',
        sampleTime: {
          physicalTime: '2026-08-17T19:45:32Z',
        },
      },
    };
    const mappedHr = adapter.mapToNormalizedSchema(hrPoint);
    expect(mappedHr[0].valueNumeric).toBe(66);
    expect(mappedHr[0].unit).toBe('bpm');
    expect(mappedHr[0].startTime).toEqual(new Date('2026-08-17T19:45:32Z'));

    // 3. Activity level with categorical text
    const actPoint = {
      userId: 'user_1',
      metricType: 'activity-level',
      activityLevel: {
        activityLevelType: 'SEDENTARY',
        interval: {
          startTime: '2026-08-17T19:37:00Z',
          endTime: '2026-08-17T19:38:00Z',
        },
      },
    };
    const mappedAct = adapter.mapToNormalizedSchema(actPoint);
    expect(mappedAct[0].valueText).toBe('SEDENTARY');
    expect(mappedAct[0].startTime).toEqual(new Date('2026-08-17T19:37:00Z'));

    // 4. Daily resting heart rate with date object { year, month, day }
    const dailyPoint = {
      userId: 'user_1',
      metricType: 'daily-resting-heart-rate',
      dailyRestingHeartRate: {
        beatsPerMinute: '59',
        date: {
          year: 2026,
          month: 8,
          day: 16,
        },
      },
    };
    const mappedDaily = adapter.mapToNormalizedSchema(dailyPoint);
    expect(mappedDaily[0].valueNumeric).toBe(59);
    expect(mappedDaily[0].unit).toBe('bpm');
    expect(mappedDaily[0].startTime).toEqual(new Date('2026-08-16T00:00:00.000Z'));
    // 5. Blood pressure with systolic and diastolic
    const bpPoint = {
      name: 'users/me/dataTypes/blood-pressure/dataPoints/bp_sample_01',
      userId: 'user_1',
      metricType: 'blood-pressure',
      sampleTime: {
        physicalTime: '2026-08-17T14:30:00Z',
      },
      bloodPressure: {
        systolicMillimetersOfMercury: 120,
        diastolicMillimetersOfMercury: 80,
      },
    };
    const mappedBp = adapter.mapToNormalizedSchema(bpPoint);
    expect(mappedBp).toHaveLength(2);

    const systolicEntry = mappedBp.find((e) => e.dimension === 'systolic');
    const diastolicEntry = mappedBp.find((e) => e.dimension === 'diastolic');

    expect(systolicEntry).toBeDefined();
    expect(systolicEntry?.valueNumeric).toBe(120);
    expect(systolicEntry?.unit).toBe('mmHg');
    expect(systolicEntry?.metricType).toBe('blood-pressure');
    expect(systolicEntry?.externalId).toBe('users/me/dataTypes/blood-pressure/dataPoints/bp_sample_01_systolic');

    expect(diastolicEntry).toBeDefined();
    expect(diastolicEntry?.valueNumeric).toBe(80);
    expect(diastolicEntry?.unit).toBe('mmHg');
    expect(diastolicEntry?.metricType).toBe('blood-pressure');
    expect(diastolicEntry?.externalId).toBe('users/me/dataTypes/blood-pressure/dataPoints/bp_sample_01_diastolic');
    // 6. Daily heart rate zones with valueMin and valueMax
    const dhrzPoint = {
      name: 'users/me/dataTypes/daily-heart-rate-zones/dataPoints/dhrz_01',
      userId: 'user_1',
      metricType: 'daily-heart-rate-zones',
      dailyHeartRateZones: {
        date: { year: 2026, month: 8, day: 20 },
        heartRateZones: [
          { heartRateZoneType: 'OUT_OF_ZONE', minBeatsPerMinute: '30', maxBeatsPerMinute: '101' },
          { heartRateZoneType: 'FAT_BURN', minBeatsPerMinute: '102', maxBeatsPerMinute: '122' },
          { heartRateZoneType: 'CARDIO', minBeatsPerMinute: '123', maxBeatsPerMinute: '148' },
          { heartRateZoneType: 'PEAK', minBeatsPerMinute: '149', maxBeatsPerMinute: '220' },
        ],
      },
    };
    const mappedZones = adapter.mapToNormalizedSchema(dhrzPoint);
    expect(mappedZones).toHaveLength(4);

    const fatBurn = mappedZones.find((z) => z.dimension === 'fat_burn');
    expect(fatBurn).toBeDefined();
    expect(fatBurn?.valueNumeric).toBeUndefined();
    expect(fatBurn?.valueMin).toBe(102);
    expect(fatBurn?.valueMax).toBe(122);
    expect(fatBurn?.unit).toBe('bpm');
    expect(fatBurn?.metricType).toBe('daily-heart-rate-zones');

    const peak = mappedZones.find((z) => z.dimension === 'peak');
    expect(peak).toBeDefined();
    expect(peak?.valueMin).toBe(149);
    expect(peak?.valueMax).toBe(220);
  });

  test('sync method skips metrics with 403 MISSING_OAUTH_SCOPE gracefully without failing entire batch', async () => {
    const adapter = new GoogleHealthAdapter();
    const res = await adapter.sync({
      userId: 'test_user_id',
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-08-05T00:00:00Z'),
      metricTypes: ['steps', 'electrocardiogram', 'heart-rate'],
      accessToken: 'mock_access_token',
    });

    expect(res.status).toBe('completed');
    expect(res.mappedEntries).toBeDefined();
    expect(res.mappedEntries!.length).toBeGreaterThan(0);
  });
});
