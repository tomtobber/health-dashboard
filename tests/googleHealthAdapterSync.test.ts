import { GoogleHealthAdapter, splitDateRange } from '../src/adapters/googleHealthAdapter';

describe('GoogleHealthAdapter Sync & Range Splitting', () => {
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
      metricTypes: ['steps', 'heart_rate'],
      accessToken: 'mock_access_token',
    });

    expect(res.status).toBe('completed');
    expect(res.pointsFetched).toBeGreaterThan(0);
    expect(res.mappedEntries).toBeDefined();
    expect(res.mappedEntries!.length).toBeGreaterThan(0);
  });
});
