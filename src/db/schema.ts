import { sql } from 'drizzle-orm';
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
  healthUserId: text('health_user_id'),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  scopes: text('scopes').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const metricDefinitions = pgTable('metric_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  metricType: text('metric_type').notNull(),
  displayName: text('display_name').notNull(),
  valueType: text('value_type').notNull(), // 'numeric' | 'duration' | 'boolean' | 'category'
  unit: text('unit'),
  categoryValues: jsonb('category_values').$type<string[]>(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userMetricIdx: uniqueIndex('metric_definitions_user_metric_idx').on(table.userId, table.metricType),
}));

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
  valueMin: doublePrecision('value_min'),
  valueMax: doublePrecision('value_max'),
  unit: text('unit'),
  dimension: text('dimension').default('default').notNull(),
  sourceStream: text('source_stream'), // 'raw' | 'reconciled' | null for manual
  aggregation: text('aggregation').default('raw').notNull(),
  rawPayload: jsonb('raw_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  rawStreamExternalIdIdx: uniqueIndex('raw_stream_external_id_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.dimension, table.externalId),
  reconciledStreamIntervalIdx: uniqueIndex('reconciled_stream_interval_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.dimension, table.startTime, table.endTime)
    .where(sql`source_stream = 'reconciled' OR external_id IS NULL`),
  canonicalQueryIdx: index('canonical_query_idx').on(table.userId, table.metricType, table.dimension, table.startTime, table.endTime),
  canonicalQueryTimeIdx: index('canonical_query_time_idx').on(table.userId, table.metricType, table.startTime, table.endTime),
  canonicalQueryAggIdx: index('canonical_query_agg_idx').on(table.userId, table.metricType, table.aggregation, table.startTime, table.endTime),
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

export interface ChartPanelConfig {
  id: string;
  panelType?: 'chart';
  metricTypes: string[];
  timeRange:
    | { type: 'relative'; value: 'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_1y' }
    | { type: 'absolute'; startTime: string; endTime: string };
  aggregation: 'raw' | '1m_avg' | '5m_avg' | 'daily_avg' | 'weekly_avg';
  chartType?: 'line' | 'bar';
}

export interface BaselinePanelConfig {
  id: string;
  panelType: 'baseline';
  metricType: string;
}

export type DashboardPanelConfig = ChartPanelConfig | BaselinePanelConfig;

export interface DashboardViewConfig {
  panels: DashboardPanelConfig[];
}

export const dashboardViews = pgTable('dashboard_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<DashboardViewConfig>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userNameIdx: uniqueIndex('dashboard_views_user_name_idx').on(table.userId, table.name),
}));

export const metricBaselineConfigs = pgTable('metric_baseline_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  metricType: text('metric_type').notNull(),
  windowDays: integer('window_days').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userMetricIdx: uniqueIndex('metric_baseline_configs_user_metric_idx').on(table.userId, table.metricType),
}));

export const metricBaselineHistory = pgTable(
  'metric_baseline_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    metricType: text('metric_type').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    windowDays: integer('window_days').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    mean: doublePrecision('mean').notNull(),
    stddev: doublePrecision('stddev').notNull(),
    min: doublePrecision('min').notNull(),
    max: doublePrecision('max').notNull(),
    sampleSize: integer('sample_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userMetricComputedIdx: uniqueIndex('metric_baseline_history_user_metric_computed_idx').on(
      table.userId,
      table.metricType,
      table.computedAt
    ),
  })
);
