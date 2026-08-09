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

  test('Test 1: context/details are omitted in production (NODE_ENV=production)', async () => {
    process.env.NODE_ENV = 'production';

    const testApp = express();
    testApp.use(express.json());

    testApp.get('/prod-app-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new ValidationError('Validation failed with context', { sensitiveInternalId: 998877 }));
    });

    testApp.get('/prod-unhandled-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error('Internal database driver crashed: postgres://admin:secret@db:5432'));
    });

    testApp.use(errorHandlerMiddleware);

    // 1. Assert AppError in production omits context
    const appErrRes = await request(testApp).get('/prod-app-error');
    expect(appErrRes.status).toBe(400);
    expect(appErrRes.body.error).toBe('Validation failed with context');
    expect(appErrRes.body.code).toBe('VALIDATION_ERROR');
    expect('context' in appErrRes.body).toBe(false);
    expect(appErrRes.body.context).toBeUndefined();

    // 2. Assert unhandled error in production omits details and uses generic error string
    const unhandledRes = await request(testApp).get('/prod-unhandled-error');
    expect(unhandledRes.status).toBe(500);
    expect(unhandledRes.body.error).toBe('Internal server error');
    expect(unhandledRes.body.code).toBe('INTERNAL_ERROR');
    expect('details' in unhandledRes.body).toBe(false);
    expect(unhandledRes.body.details).toBeUndefined();
  });

  test('Test 2: the catch-all branch for non-AppError exceptions', async () => {
    // NODE_ENV defaults to test (not production)
    const testApp = express();
    testApp.use(express.json());

    const internalErrorMessage = 'some internal message';

    testApp.get('/raw-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error(internalErrorMessage));
    });

    testApp.use(errorHandlerMiddleware);

    const res = await request(testApp).get('/raw-error');

    expect(res.status).toBe(500);
    // Asserts error field is generic "Internal server error", NOT "some internal message"
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toBe(internalErrorMessage);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    // Note: details field contains the internal message when NODE_ENV !== 'production'
    expect(res.body.details).toBe(internalErrorMessage);
  });

  test('AppError cause chaining stores original error object and omits cause from JSON.stringify output', () => {
    const rootCause = new Error('Low-level database connection reset by peer');
    const dbError = new DatabaseError('Database operation failed', { table: 'users' }, rootCause);

    expect(dbError.cause).toBe(rootCause);
    expect(dbError.cause).toBeInstanceOf(Error);
    expect((dbError.cause as Error).message).toBe('Low-level database connection reset by peer');

    const jsonString = JSON.stringify(dbError);
    const parsed = JSON.parse(jsonString);

    expect(parsed).toHaveProperty('message', 'Database operation failed');
    expect(parsed).toHaveProperty('code', 'DATABASE_ERROR');
    expect(parsed).not.toHaveProperty('cause');
    expect(jsonString).not.toContain('Low-level database connection reset by peer');
  });

  test('Non-operational AppError (isOperational=false) is handled as internal server error 500 by middleware and respects NODE_ENV', async () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.get('/non-operational-error', (_req: Request, _res: Response, next: NextFunction) => {
      next(new AppError('Internal assertion failed', 500, 'BUG_ERROR', {}, undefined, false));
    });

    testApp.use(errorHandlerMiddleware);

    // 1. In non-production (test env): details field contains the message
    process.env.NODE_ENV = 'test';
    const devRes = await request(testApp).get('/non-operational-error');
    expect(devRes.status).toBe(500);
    expect(devRes.body.error).toBe('Internal server error');
    expect(devRes.body.code).toBe('INTERNAL_ERROR');
    expect(devRes.body.details).toBe('Internal assertion failed');

    // 2. In production: details field is omitted entirely
    process.env.NODE_ENV = 'production';
    const prodRes = await request(testApp).get('/non-operational-error');
    expect(prodRes.status).toBe(500);
    expect(prodRes.body.error).toBe('Internal server error');
    expect(prodRes.body.code).toBe('INTERNAL_ERROR');
    expect('details' in prodRes.body).toBe(false);
    expect(prodRes.body.details).toBeUndefined();
  });

  test('AppError creates a defensive shallow copy of the context object', () => {
    const mutableContext = { fieldName: 'email', count: 1 };
    const error = new ValidationError('Validation failed', mutableContext);

    // Mutate the original context object after error construction
    mutableContext.fieldName = 'password';
    mutableContext.count = 99;

    expect(error.context).toEqual({ fieldName: 'email', count: 1 });
    expect(error.context.fieldName).toBe('email');
    expect(error.context.count).toBe(1);
  });
});
