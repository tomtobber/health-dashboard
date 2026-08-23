import { pool } from './index';
import { logger } from '../utils/logger';

export async function ensureDatabaseSchema(): Promise<void> {
  logger.info('Verifying and ensuring database schema idempotently on startup...', {
    operation: 'ensureDatabaseSchema',
  });

  try {
    // 1. Core Schema DDL
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS connected_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        health_user_id TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        scopes JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS metric_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        value_type TEXT NOT NULL,
        unit TEXT,
        category_values JSONB,
        archived_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_user_metric_type_idx
        ON metric_definitions (user_id, metric_type);

      CREATE TABLE IF NOT EXISTS metric_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        external_id TEXT,
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE NOT NULL,
        value_numeric DOUBLE PRECISION,
        value_text TEXT,
        value_min DOUBLE PRECISION,
        value_max DOUBLE PRECISION,
        unit TEXT,
        dimension TEXT NOT NULL DEFAULT 'default',
        source_stream TEXT,
        aggregation TEXT NOT NULL DEFAULT 'raw',
        raw_payload JSONB,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMP WITH TIME ZONE
      );

      -- Idempotently ensure columns if table already existed
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_min DOUBLE PRECISION;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_max DOUBLE PRECISION;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_text TEXT;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS dimension TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS aggregation TEXT NOT NULL DEFAULT 'raw';
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS raw_payload JSONB;

      CREATE UNIQUE INDEX IF NOT EXISTS raw_stream_external_id_idx
        ON metric_entries (user_id, provider, metric_type, source_stream, dimension, external_id);

      CREATE UNIQUE INDEX IF NOT EXISTS reconciled_stream_interval_idx
        ON metric_entries (user_id, provider, metric_type, source_stream, dimension, start_time, end_time)
        WHERE (source_stream = 'reconciled' OR external_id IS NULL);

      CREATE INDEX IF NOT EXISTS canonical_query_idx
        ON metric_entries (user_id, metric_type, dimension, start_time, end_time);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        metric_type TEXT,
        trigger TEXT NOT NULL,
        requested_range_start TIMESTAMP WITH TIME ZONE,
        requested_range_end TIMESTAMP WITH TIME ZONE,
        status TEXT NOT NULL,
        points_fetched INTEGER NOT NULL DEFAULT 0,
        points_upserted INTEGER NOT NULL DEFAULT 0,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS dashboard_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS dashboard_views_user_name_idx 
        ON dashboard_views (user_id, name);
    `);

    // 2. Tracked One-Time Data Migrations (Runs only once across deployments)
    await runTrackedMigration('20260823_repair_blood_glucose_numeric', async () => {
      await pool.query(`
        UPDATE metric_entries
        SET
          value_numeric = COALESCE(
            (raw_payload->'bloodGlucose'->>'bloodGlucoseMilligramsPerDeciliter')::double precision,
            (raw_payload->'blood-glucose'->>'bloodGlucoseMilligramsPerDeciliter')::double precision,
            (raw_payload->'bloodGlucose'->>'bloodGlucoseMmolPerLiter')::double precision * 18.0182,
            (raw_payload->'blood-glucose'->>'bloodGlucoseMmolPerLiter')::double precision * 18.0182,
            (raw_payload->'bloodGlucose'->>'bloodGlucoseConcentration')::double precision,
            (raw_payload->'blood-glucose'->>'bloodGlucoseConcentration')::double precision,
            value_numeric
          ),
          unit = COALESCE(unit, 'mg/dL'),
          dimension = COALESCE(
            LOWER(raw_payload->'bloodGlucose'->>'measurementSource'),
            LOWER(raw_payload->'blood-glucose'->>'measurementSource'),
            dimension
          )
        WHERE
          metric_type IN ('blood-glucose', 'blood_glucose')
          AND (value_numeric IS NULL OR value_numeric = 0)
          AND raw_payload IS NOT NULL;
      `);
    });

    logger.info('Database schema verified and ready.', {
      operation: 'ensureDatabaseSchema',
    });
  } catch (err: unknown) {
    logger.error('Failed to ensure database schema on startup', {
      operation: 'ensureDatabaseSchema',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runTrackedMigration(version: string, runner: () => Promise<void>): Promise<void> {
  const check = await pool.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
  if (check.rowCount === 0) {
    logger.info(`Executing tracked migration: ${version}...`, {
      operation: 'runTrackedMigration',
      version,
    });
    await runner();
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    logger.info(`Tracked migration ${version} completed.`, {
      operation: 'runTrackedMigration',
      version,
    });
  }
}
