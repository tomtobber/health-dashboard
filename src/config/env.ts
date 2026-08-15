import { z } from 'zod';
import * as dotenv from 'dotenv';
import { ValidationError } from '../errors/AppError';

dotenv.config();

const KNOWN_PLACEHOLDERS = [
  'mock-google-client-id',
  'mock-google-client-secret',
  'YOUR_GOOGLE_CLIENT_ID',
  'YOUR_GOOGLE_CLIENT_SECRET',
  'placeholder',
];

export const envSchema = z
  .object({
    PORT: z.string().default('3000'),
    DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/health_dashboard'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
    ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),
    CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters long').default('local-dev-cron-secret-min-16-chars'),
    WEBHOOK_AUTH_TOKEN: z.string().min(16, 'WEBHOOK_AUTH_TOKEN must be at least 16 characters long').default('local-dev-webhook-auth-token-min-16-chars'),
    GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
    GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
    GOOGLE_REDIRECT_URI: z.string().url('GOOGLE_REDIRECT_URI must be a valid URL'),
    APP_BASE_URL: z.string().default('http://localhost:3000'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'test') {
      if (KNOWN_PLACEHOLDERS.includes(data.GOOGLE_CLIENT_ID)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_CLIENT_ID'],
          message: 'GOOGLE_CLIENT_ID is set to a placeholder value. A real Google OAuth Client ID is required in .env for development and production.',
        });
      }
      if (KNOWN_PLACEHOLDERS.includes(data.GOOGLE_CLIENT_SECRET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_CLIENT_SECRET'],
          message: 'GOOGLE_CLIENT_SECRET is set to a placeholder value. A real Google OAuth Client Secret is required in .env for development and production.',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(envObj: Record<string, unknown> = process.env): Env {
  // If explicitly in test mode (NODE_ENV=test), supply safe test defaults for missing vars
  const isTest = envObj.NODE_ENV === 'test' || (envObj.NODE_ENV === undefined && process.env.NODE_ENV === 'test');
  const targetEnv = isTest
    ? {
        PORT: '3000',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/health_dashboard',
        JWT_SECRET: 'super-secret-jwt-key-min-32-chars-length',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        CRON_SECRET: 'real-cron-secret-min-16-chars-long',
        WEBHOOK_AUTH_TOKEN: 'real-webhook-auth-token-min-16-chars',
        GOOGLE_CLIENT_ID: 'mock-google-client-id',
        GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/connect/google/callback',
        APP_BASE_URL: 'http://localhost:3000',
        NODE_ENV: 'test',
        ...envObj,
      }
    : envObj;

  const result = envSchema.safeParse(targetEnv);
  if (!result.success) {
    const errorDetails = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ValidationError(`Environment variable validation failed: ${errorDetails}`, {
      zodErrors: result.error.errors,
    });
  }
  return result.data;
}

export const env = loadEnv();
