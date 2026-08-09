import { z } from 'zod';
import * as dotenv from 'dotenv';
import { ValidationError } from '../errors/AppError';

dotenv.config();

export const envSchema = z.object({
  PORT: z.string().default('3000'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/health_dashboard'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),
  GOOGLE_CLIENT_ID: z.string().default('mock-google-client-id'),
  GOOGLE_CLIENT_SECRET: z.string().default('mock-google-client-secret'),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3000/api/connect/google/callback'),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errorDetails = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ValidationError(`Environment variable validation failed: ${errorDetails}`, {
      zodErrors: result.error.errors,
    });
  }
  return result.data;
}

export const env = loadEnv();