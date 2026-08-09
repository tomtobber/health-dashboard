import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import {
  AppError,
  ValidationError,
  AuthenticationError,
  NotFoundError,
  ExternalServiceError,
  DatabaseError,
  CryptographicError,
} from '../src/errors/AppError';
import { errorHandlerMiddleware } from '../src/app';

describe('AppError JSON Serialization & Error Middleware Verification', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  const errorInstances: AppError[] = [
    new ValidationError('Invalid email format', { field: 'email' }),
    new AuthenticationError('Invalid or expired JWT token'),
    new NotFoundError('Requested metric entry not found'),
    new ExternalServiceError('GoogleHealthAPI', 'Upstream gateway timeout', 504),
    new DatabaseError('Database connection pool exhausted'),
    new CryptographicError('AES-256-GCM authentication tag mismatch'),
  ];

  test('JSON.stringify(err) includes enumerable message and name for all 6 AppError subclasses', () => {
    for (const err of errorInstances) {
      const serialized = JSON.stringify(err);
      const parsed = JSON.parse(serialized);

      expect(parsed).toHaveProperty('message');
      expect(parsed.message).toEqual(err.message);
      expect(parsed).toHaveProperty('name');
      expect(parsed.name).toEqual(err.name);
      expect(parsed).toHaveProperty('statusCode');
      expect(parsed.statusCode).toEqual(err.statusCode);
      expect(parsed).toHaveProperty('code');
      expect(parsed.code).toEqual(err.code);
    }
  });

  test('Express error handling middleware serializes AppError subclass with correct message and status code', async () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.get('/test-error/:type', (req: Request, res: Response, next: NextFunction) => {
      switch (req.params.type) {
        case 'validation':
          return next(new ValidationError('Invalid parameter input'));
        case 'auth':
          return next(new AuthenticationError('Unauthorized access'));
        case 'notfound':
          return next(new NotFoundError('Resource missing'));
        case 'external':
          return next(new ExternalServiceError('GoogleAPI', 'Token exchange failed', 400));
        case 'database':
          return next(new DatabaseError('Query execution failed'));
        case 'crypto':
          return next(new CryptographicError('Decryption failed'));
        default:
          return next(new AppError('Generic app error', 500, 'GENERIC_ERROR'));
      }
    });

    testApp.use(errorHandlerMiddleware);

    const routesToTest = [
      { path: '/test-error/validation', expectedStatus: 400, expectedMessage: 'Invalid parameter input', expectedCode: 'VALIDATION_ERROR' },
      { path: '/test-error/auth', expectedStatus: 401, expectedMessage: 'Unauthorized access', expectedCode: 'AUTHENTICATION_ERROR' },
      { path: '/test-error/notfound', expectedStatus: 404, expectedMessage: 'Resource missing', expectedCode: 'NOT_FOUND_ERROR' },
      { path: '/test-error/external', expectedStatus: 502, expectedMessage: 'External Service Error [GoogleAPI]: Token exchange failed', expectedCode: 'EXTERNAL_SERVICE_ERROR' },
      { path: '/test-error/database', expectedStatus: 500, expectedMessage: 'Query execution failed', expectedCode: 'DATABASE_ERROR' },
      { path: '/test-error/crypto', expectedStatus: 500, expectedMessage: 'Decryption failed', expectedCode: 'CRYPTOGRAPHIC_ERROR' },
    ];

    for (const route of routesToTest) {
      const res = await request(testApp).get(route.path);
      expect(res.status).toBe(route.expectedStatus);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toEqual(route.expectedMessage);
      expect(res.body).toHaveProperty('code');
      expect(res.body.code).toEqual(route.expectedCode);
      expect(res.body).not.toHaveProperty('stack');
    }
  });

  test('Omits context from AppError and details from unhandled errors when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';

    const testApp = express();
    testApp.use(express.json());

    testApp.get('/prod-app-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new ValidationError('Validation failed', { sensitiveInternalId: 998877 }));
    });

    testApp.get('/prod-unhandled-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error('Internal database driver crashed: postgres://admin:secret@db:5432'));
    });

    testApp.use(errorHandlerMiddleware);

    // 1. Assert AppError in production omits context
    const appErrRes = await request(testApp).get('/prod-app-error');
    expect(appErrRes.status).toBe(400);
    expect(appErrRes.body.error).toBe('Validation failed');
    expect(appErrRes.body.code).toBe('VALIDATION_ERROR');
    expect(appErrRes.body.context).toBeUndefined();

    // 2. Assert unhandled error in production omits details
    const unhandledRes = await request(testApp).get('/prod-unhandled-error');
    expect(unhandledRes.status).toBe(500);
    expect(unhandledRes.body.error).toBe('Internal server error');
    expect(unhandledRes.body.code).toBe('INTERNAL_ERROR');
    expect(unhandledRes.body.details).toBeUndefined();
  });

  test('Catch-all branch hides real error message and returns generic Internal server error when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';

    const testApp = express();
    testApp.use(express.json());

    const sensitiveErrorMsg = 'Uncaught fatal exception: Redis secret key /var/run/secrets leaked';

    testApp.get('/throw-plain-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error(sensitiveErrorMsg));
    });

    testApp.use(errorHandlerMiddleware);

    const res = await request(testApp).get('/throw-plain-error');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(res.body)).not.toContain(sensitiveErrorMsg);
  });
});