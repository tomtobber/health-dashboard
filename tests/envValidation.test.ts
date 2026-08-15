import { loadEnv } from '../src/config/env';
import { ValidationError } from '../src/errors/AppError';

describe('Environment Variable Startup Validation', () => {
  const baseValidEnv = {
    PORT: '3000',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/health_dashboard',
    JWT_SECRET: 'super-secret-jwt-key-min-32-chars-length',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CRON_SECRET: 'real-cron-secret-min-16-chars-long',
    WEBHOOK_AUTH_TOKEN: 'real-webhook-auth-token-min-16-chars',
    GOOGLE_CLIENT_ID: 'real-google-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'real-google-client-secret-12345',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/connect/google/callback',
    GOOGLE_PROJECT_ID: 'my-gcp-project-123',
    GOOGLE_SUBSCRIBER_ID: 'health-dashboard-sub',
    APP_BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
  };

  test('succeeds when all required env vars have valid non-placeholder values', () => {
    const loaded = loadEnv(baseValidEnv);
    expect(loaded.GOOGLE_CLIENT_ID).toBe('real-google-client-id.apps.googleusercontent.com');
    expect(loaded.GOOGLE_CLIENT_SECRET).toBe('real-google-client-secret-12345');
    expect(loaded.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/api/connect/google/callback');
    expect(loaded.GOOGLE_SUBSCRIBER_ID).toBe('health-dashboard-sub');
    expect(loaded.CRON_SECRET).toBe('real-cron-secret-min-16-chars-long');
    expect(loaded.WEBHOOK_AUTH_TOKEN).toBe('real-webhook-auth-token-min-16-chars');
  });

  test('fails at startup with ValidationError when GOOGLE_CLIENT_ID is missing', () => {
    const { GOOGLE_CLIENT_ID: _, ...missingClientIdEnv } = baseValidEnv;
    expect(() => loadEnv(missingClientIdEnv)).toThrow(ValidationError);
    try {
      loadEnv(missingClientIdEnv);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('GOOGLE_CLIENT_ID');
    }
  });

  test('fails at startup with ValidationError when GOOGLE_CLIENT_SECRET is missing', () => {
    const { GOOGLE_CLIENT_SECRET: _, ...missingClientSecretEnv } = baseValidEnv;
    expect(() => loadEnv(missingClientSecretEnv)).toThrow(ValidationError);
    try {
      loadEnv(missingClientSecretEnv);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('GOOGLE_CLIENT_SECRET');
    }
  });

  test('fails at startup with ValidationError when GOOGLE_CLIENT_ID is set to a placeholder', () => {
    const placeholderEnv = {
      ...baseValidEnv,
      GOOGLE_CLIENT_ID: 'mock-google-client-id',
    };
    expect(() => loadEnv(placeholderEnv)).toThrow(ValidationError);
    try {
      loadEnv(placeholderEnv);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('GOOGLE_CLIENT_ID');
      expect((err as ValidationError).message).toContain('placeholder');
    }
  });

  test('fails at startup with ValidationError when GOOGLE_CLIENT_SECRET is set to a placeholder', () => {
    const placeholderEnv = {
      ...baseValidEnv,
      GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
    };
    expect(() => loadEnv(placeholderEnv)).toThrow(ValidationError);
    try {
      loadEnv(placeholderEnv);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('GOOGLE_CLIENT_SECRET');
      expect((err as ValidationError).message).toContain('placeholder');
    }
  });

  test('fails when GOOGLE_SUBSCRIBER_ID has invalid format', () => {
    const invalidSubEnv = {
      ...baseValidEnv,
      GOOGLE_SUBSCRIBER_ID: '123_invalid_subscriber_ID_$$$',
    };
    expect(() => loadEnv(invalidSubEnv)).toThrow(ValidationError);
  });

  test('fails when CRON_SECRET is shorter than 16 characters', () => {
    const invalidCronEnv = {
      ...baseValidEnv,
      CRON_SECRET: 'short-secret',
    };
    expect(() => loadEnv(invalidCronEnv)).toThrow(ValidationError);
  });

  test('fails when WEBHOOK_AUTH_TOKEN is shorter than 16 characters', () => {
    const invalidWebhookEnv = {
      ...baseValidEnv,
      WEBHOOK_AUTH_TOKEN: 'short-token',
    };
    expect(() => loadEnv(invalidWebhookEnv)).toThrow(ValidationError);
  });

  test('allows test placeholders in test mode (NODE_ENV=test)', () => {
    const testEnv = {
      ...baseValidEnv,
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: 'mock-google-client-id',
      GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
    };
    const loaded = loadEnv(testEnv);
    expect(loaded.GOOGLE_CLIENT_ID).toBe('mock-google-client-id');
  });
});
