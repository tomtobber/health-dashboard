import { pgTable, uuid, text, timestamp, doublePrecision, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const connectedAccounts = pgTable('connected_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  scopes: text('scopes').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const metricEntries = pgTable('metric_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  metricType: text('metric_type').notNull(),
  externalId: text('external_id'),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  valueNumeric: doublePrecision('value_numeric'),
  valueText: text('value_text'),
  unit: text('unit').notNull(),
  sourceStream: text('source_stream').notNull(), // 'raw' | 'reconciled'
  aggregation: text('aggregation').default('raw').notNull(),
  rawPayload: jsonb('raw_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  rawStreamExternalIdIdx: uniqueIndex('raw_stream_external_id_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.externalId),
  reconciledStreamIntervalIdx: uniqueIndex('reconciled_stream_interval_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.startTime, table.endTime),
  canonicalQueryIdx: index('canonical_query_idx').on(table.userId, table.metricType, table.startTime, table.endTime),
}));

export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  metricType: text('metric_type'),
  trigger: text('trigger').notNull(),
  requestedRangeStart: timestamp('requested_range_start', { withTimezone: true }),
  requestedRangeEnd: timestamp('requested_range_end', { withTimezone: true }),
  status: text('status').notNull(),
  pointsFetched: integer('points_fetched').default(0).notNull(),
  pointsUpserted: integer('points_upserted').default(0).notNull(),
  pagesFetched: integer('pages_fetched').default(0).notNull(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
