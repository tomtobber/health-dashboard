import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { authRouter } from './routes/authRoutes';
import { connectRouter } from './routes/connectRoutes';
import { webhookRouter } from './routes/webhookRoutes';
import { syncRouter } from './routes/syncRoutes';
import { metricDefinitionRouter } from './routes/metricDefinitionRoutes';
import { manualEntryRouter } from './routes/manualEntryRoutes';
import { dashboardViewRouter } from './routes/dashboardViewRoutes';
import { baselineRouter } from './routes/baselineRoutes';
import { correlationRouter } from './routes/correlationRoutes';
import { AppError } from './errors/AppError';
import { logger } from './utils/logger';

export const app = express();

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/connect', connectRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/sync', syncRouter);
app.use('/api/metric-definitions', metricDefinitionRouter);
app.use('/api/metric-entries', manualEntryRouter);
app.use('/api/dashboard-views', dashboardViewRouter);
app.use('/api/metrics', baselineRouter);
app.use('/api/metrics', correlationRouter);

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Multi-strategy resolution for frontend static assets
const candidatePaths = [
  path.join(__dirname, '../client/dist'),
  path.resolve(process.cwd(), 'client/dist'),
  path.join(__dirname, 'client/dist'),
];

let clientDistPath = candidatePaths[0];
for (const p of candidatePaths) {
  if (fs.existsSync(p)) {
    clientDistPath = p;
    break;
  }
}

logger.info('Resolved frontend static asset path', {
  clientDistPath,
  exists: fs.existsSync(clientDistPath),
  indexExists: fs.existsSync(path.join(clientDistPath, 'index.html')),
});

app.use(
  express.static(clientDistPath, {
    setHeaders: (res, filePath) => {
      // Content-hashed assets inside assets/ directory (e.g. JS, CSS, fonts) are immutable
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (normalizedPath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (normalizedPath.endsWith('index.html')) {
        // index.html must never be cached so users immediately receive updated bundle hashes on deploy
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

// Express 4 & 5 safe pathless SPA fallback handler (registered strictly after all /api and /health routes)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && req.path !== '/health') {
    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(indexPath);
    }
  }
  next();
});

// Centralized Error Handling Middleware complying with Constraints #1, #2, #8
export function errorHandlerMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.isOperational) {
      logger.error(`Application Error [${err.code}]: ${err.message}`, {
        operation: 'ErrorHandlerMiddleware',
        path: req.path,
        method: req.method,
        statusCode: err.statusCode,
        code: err.code,
        context: err.context,
        error: err,
      });

      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        context: process.env.NODE_ENV !== 'production' ? err.context : undefined,
      });
    }

    // Non-operational AppError (programmer bug / unexpected internal invariant failure)
    logger.error(`Non-operational Bug [${err.code}]: ${err.message}`, {
      operation: 'ErrorHandlerMiddleware',
      path: req.path,
      method: req.method,
      isOperational: false,
      statusCode: err.statusCode,
      code: err.code,
      context: err.context,
      error: err,
    });

    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }

  if (err instanceof z.ZodError) {
    logger.warn('Unhandled Zod validation error', {
      operation: 'ErrorHandlerMiddleware',
      path: req.path,
      method: req.method,
      zodErrors: err.errors,
    });

    return res.status(400).json({
      error: 'Invalid input parameters',
      code: 'VALIDATION_ERROR',
      details: err.errors,
    });
  }

  const unhandledError = err instanceof Error ? err : new Error(String(err));
  logger.error('Unhandled internal server error', {
    operation: 'ErrorHandlerMiddleware',
    path: req.path,
    method: req.method,
    error: unhandledError,
  });

  return res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    details: process.env.NODE_ENV !== 'production' ? unhandledError.message : undefined,
  });
}

app.use(errorHandlerMiddleware);
