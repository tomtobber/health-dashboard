"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncRuns = exports.metricEntries = exports.connectedAccounts = exports.users = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
exports.users = (0, pg_core_1.pgTable)('users', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    email: (0, pg_core_1.text)('email').notNull().unique(),
    passwordHash: (0, pg_core_1.text)('password_hash').notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
exports.connectedAccounts = (0, pg_core_1.pgTable)('connected_accounts', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').references(() => exports.users.id, { onDelete: 'cascade' }).notNull(),
    provider: (0, pg_core_1.text)('provider').notNull(),
    accessToken: (0, pg_core_1.text)('access_token').notNull(),
    refreshToken: (0, pg_core_1.text)('refresh_token').notNull(),
    scopes: (0, pg_core_1.text)('scopes').notNull(),
    status: (0, pg_core_1.text)('status').default('active').notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
exports.metricEntries = (0, pg_core_1.pgTable)('metric_entries', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').references(() => exports.users.id, { onDelete: 'cascade' }).notNull(),
    provider: (0, pg_core_1.text)('provider').notNull(),
    metricType: (0, pg_core_1.text)('metric_type').notNull(),
    externalId: (0, pg_core_1.text)('external_id'),
    startTime: (0, pg_core_1.timestamp)('start_time', { withTimezone: true }).notNull(),
    endTime: (0, pg_core_1.timestamp)('end_time', { withTimezone: true }).notNull(),
    valueNumeric: (0, pg_core_1.doublePrecision)('value_numeric'),
    valueText: (0, pg_core_1.text)('value_text'),
    unit: (0, pg_core_1.text)('unit').notNull(),
    sourceStream: (0, pg_core_1.text)('source_stream').notNull(), // 'raw' | 'reconciled'
    aggregation: (0, pg_core_1.text)('aggregation').default('raw').notNull(),
    rawPayload: (0, pg_core_1.jsonb)('raw_payload'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: (0, pg_core_1.timestamp)('deleted_at', { withTimezone: true }),
}, (table) => ({
    rawStreamExternalIdIdx: (0, pg_core_1.uniqueIndex)('raw_stream_external_id_idx')
        .on(table.userId, table.provider, table.metricType, table.sourceStream, table.externalId)
        .where((0, drizzle_orm_1.sql) `external_id IS NOT NULL`),
    reconciledStreamIntervalIdx: (0, pg_core_1.uniqueIndex)('reconciled_stream_interval_idx')
        .on(table.userId, table.provider, table.metricType, table.sourceStream, table.startTime, table.endTime)
        .where((0, drizzle_orm_1.sql) `external_id IS NULL`),
    canonicalQueryIdx: (0, pg_core_1.index)('canonical_query_idx').on(table.userId, table.metricType, table.startTime, table.endTime),
}));
exports.syncRuns = (0, pg_core_1.pgTable)('sync_runs', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').references(() => exports.users.id, { onDelete: 'cascade' }).notNull(),
    provider: (0, pg_core_1.text)('provider').notNull(),
    metricType: (0, pg_core_1.text)('metric_type'),
    trigger: (0, pg_core_1.text)('trigger').notNull(),
    requestedRangeStart: (0, pg_core_1.timestamp)('requested_range_start', { withTimezone: true }),
    requestedRangeEnd: (0, pg_core_1.timestamp)('requested_range_end', { withTimezone: true }),
    status: (0, pg_core_1.text)('status').notNull(),
    pointsFetched: (0, pg_core_1.integer)('points_fetched').default(0).notNull(),
    pointsUpserted: (0, pg_core_1.integer)('points_upserted').default(0).notNull(),
    pagesFetched: (0, pg_core_1.integer)('pages_fetched').default(0).notNull(),
    error: (0, pg_core_1.text)('error'),
    startedAt: (0, pg_core_1.timestamp)('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: (0, pg_core_1.timestamp)('completed_at', { withTimezone: true }),
});
