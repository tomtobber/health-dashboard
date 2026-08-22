-- ============================================================================
-- Migration: 0003_phase3_custom_metrics.sql
-- Description: Phase 3 Custom Metrics, Manual Entry & Compound Metrics Schema
-- Target Database: PostgreSQL (Neon / AWS Europe Frankfurt)
-- Safe & Idempotent: Yes (IF NOT EXISTS & non-destructive ALTERs)
-- ============================================================================

-- 1. Ensure all columns exist on metric_entries
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_numeric DOUBLE PRECISION;
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_text TEXT;
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_min DOUBLE PRECISION;
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_max DOUBLE PRECISION;
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS dimension TEXT NOT NULL DEFAULT 'default';
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS aggregation TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE metric_entries ALTER COLUMN unit DROP NOT NULL;
ALTER TABLE metric_entries ALTER COLUMN source_stream DROP NOT NULL;

-- 2. Create the metric_definitions table
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

-- 3. Create compound unique index on (user_id, metric_type)
CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_user_metric_idx 
    ON metric_definitions (user_id, metric_type);

