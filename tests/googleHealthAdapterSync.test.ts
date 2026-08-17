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
});
