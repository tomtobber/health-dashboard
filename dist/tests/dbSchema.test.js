"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schema_1 = require("../src/db/schema");
const drizzle_orm_1 = require("drizzle-orm");
describe('dbSchema verification', () => {
    test('metricEntries contains required columns with correct settings', () => {
        const columns = (0, drizzle_orm_1.getTableColumns)(schema_1.metricEntries);
        expect(columns).toHaveProperty('id');
        expect(columns).toHaveProperty('userId');
        expect(columns).toHaveProperty('provider');
        expect(columns).toHaveProperty('metricType');
        expect(columns).toHaveProperty('externalId');
        expect(columns.startTime.notNull).toBe(true);
        expect(columns.endTime.notNull).toBe(true);
        expect(columns).toHaveProperty('valueNumeric');
        expect(columns).toHaveProperty('valueText');
        expect(columns).toHaveProperty('unit');
        expect(columns).toHaveProperty('sourceStream');
        expect(columns).toHaveProperty('aggregation');
        expect(columns).toHaveProperty('rawPayload');
        expect(columns).toHaveProperty('deletedAt');
    });
    test('connectedAccounts contains encrypted token columns and scopes', () => {
        const columns = (0, drizzle_orm_1.getTableColumns)(schema_1.connectedAccounts);
        expect(columns).toHaveProperty('accessToken');
        expect(columns).toHaveProperty('refreshToken');
        expect(columns).toHaveProperty('scopes');
        expect(columns).toHaveProperty('status');
    });
});
