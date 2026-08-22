import { metricEntries, connectedAccounts } from '../src/db/schema';
import { getTableColumns } from 'drizzle-orm';

describe('dbSchema verification', () => {
  test('metricEntries contains required columns with correct settings', () => {
    const columns = getTableColumns(metricEntries);

    expect(columns).toHaveProperty('id');
    expect(columns).toHaveProperty('userId');
    expect(columns).toHaveProperty('provider');
    expect(columns).toHaveProperty('metricType');
    expect(columns).toHaveProperty('externalId');
    expect(columns.startTime.notNull).toBe(true);
    expect(columns.endTime.notNull).toBe(true);
    expect(columns).toHaveProperty('valueNumeric');
    expect(columns).toHaveProperty('valueText');
    expect(columns).toHaveProperty('valueMin');
    expect(columns).toHaveProperty('valueMax');
    expect(columns).toHaveProperty('unit');
    expect(columns).toHaveProperty('dimension');
    expect(columns).toHaveProperty('sourceStream');
    expect(columns).toHaveProperty('aggregation');
    expect(columns).toHaveProperty('rawPayload');
    expect(columns).toHaveProperty('deletedAt');
  });

  test('connectedAccounts contains encrypted token columns and scopes', () => {
    const columns = getTableColumns(connectedAccounts);
    expect(columns).toHaveProperty('accessToken');
    expect(columns).toHaveProperty('refreshToken');
    expect(columns).toHaveProperty('scopes');
    expect(columns).toHaveProperty('status');
  });
});