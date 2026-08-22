import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

async function migrate() {
  try {
    logger.info('Running Phase 5 DB DDL migration (dashboard_views)...');

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS dashboard_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS dashboard_views_user_name_idx 
        ON dashboard_views (user_id, name);
    `);

    logger.info('Phase 5 DB DDL migration completed successfully');
    process.exit(0);
  } catch (err: unknown) {
    logger.error('Phase 5 Migration failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

void migrate();
