-- ============================================================================
-- Migration: 0004_phase5_dashboard_views.sql
-- Description: Phase 5 Saved Dashboard Views Schema
-- Target Database: PostgreSQL (Neon / AWS Europe Frankfurt)
-- Safe & Idempotent: Yes (IF NOT EXISTS)
-- ============================================================================

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
