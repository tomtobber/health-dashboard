import { app } from './app';
import { ensureDatabaseSchema } from './db/bootstrap';
import { logger } from './utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await ensureDatabaseSchema();
    app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`, { port: PORT });
    });
  } catch (err: unknown) {
    logger.error('Server startup aborted due to database schema initialization failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void startServer();
