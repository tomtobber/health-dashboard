import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

async function migrate() {
  try {
    logger.info('Running Phase 3 DB DDL migration...');

    await db.execute(sql`
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
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_user_metric_idx 
        ON metric_definitions (user_id, metric_type);
    `);

    await db.execute(sql`
      ALTER TABLE metric_entries ALTER COLUMN unit DROP NOT NULL;
    `);

    await db.execute(sql`
      ALTER TABLE metric_entries ALTER COLUMN source_stream DROP NOT NULL;
    `);

    logger.info('Phase 3 DB DDL migration completed successfully');
    process.exit(0);
  } catch (err: unknown) {
    logger.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

void migrate();
