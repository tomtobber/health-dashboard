-- ============================================================================
-- Migration: 0003_phase3_custom_metrics.sql
-- Description: Phase 3 Custom Metrics & Manual Entry Schema
-- Target Database: PostgreSQL (Neon / AWS Europe Frankfurt)
-- Safe & Idempotent: Yes (IF NOT EXISTS & non-destructive ALTERs)
-- ============================================================================

-- 1. Create the metric_definitions table
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

-- 2. Create compound unique index on (user_id, metric_type)
CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_user_metric_idx 
    ON metric_definitions (user_id, metric_type);

-- 3. Relax unit column nullability on metric_entries (unit is null for boolean and category types)
ALTER TABLE metric_entries ALTER COLUMN unit DROP NOT NULL;

-- 4. Relax source_stream column nullability on metric_entries (source_stream is null for manual entries)
ALTER TABLE metric_entries ALTER COLUMN source_stream DROP NOT NULL;
