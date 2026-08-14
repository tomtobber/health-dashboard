import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { authRouter } from './routes/authRoutes';
import { connectRouter } from './routes/connectRoutes';
import { webhookRouter } from './routes/webhookRoutes';
import { syncRouter } from './routes/syncRoutes';
import { AppError } from './errors/AppError';
import { logger } from './utils/logger';

export const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/connect', connectRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/sync', syncRouter);

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
