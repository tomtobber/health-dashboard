import { z } from 'zod';
export declare const envSchema: z.ZodObject<{
    PORT: z.ZodDefault<z.ZodString>;
    DATABASE_URL: z.ZodDefault<z.ZodString>;
    JWT_SECRET: z.ZodString;
    ENCRYPTION_KEY: z.ZodString;
    GOOGLE_CLIENT_ID: z.ZodDefault<z.ZodString>;
    GOOGLE_CLIENT_SECRET: z.ZodDefault<z.ZodString>;
    GOOGLE_REDIRECT_URI: z.ZodDefault<z.ZodString>;
    APP_BASE_URL: z.ZodDefault<z.ZodString>;
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "test", "production"]>>;
}, "strip", z.ZodTypeAny, {
    DATABASE_URL: string;
    PORT: string;
    JWT_SECRET: string;
    ENCRYPTION_KEY: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REDIRECT_URI: string;
    APP_BASE_URL: string;
    NODE_ENV: "development" | "test" | "production";
}, {
    JWT_SECRET: string;
    ENCRYPTION_KEY: string;
    DATABASE_URL?: string | undefined;
    PORT?: string | undefined;
    GOOGLE_CLIENT_ID?: string | undefined;
    GOOGLE_CLIENT_SECRET?: string | undefined;
    GOOGLE_REDIRECT_URI?: string | undefined;
    APP_BASE_URL?: string | undefined;
    NODE_ENV?: "development" | "test" | "production" | undefined;
}>;
export type Env = z.infer<typeof envSchema>;
export declare const env: {
    DATABASE_URL: string;
    PORT: string;
    JWT_SECRET: string;
    ENCRYPTION_KEY: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REDIRECT_URI: string;
    APP_BASE_URL: string;
    NODE_ENV: "development" | "test" | "production";
};
