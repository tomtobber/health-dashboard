const fs = require('fs');
const path = require('path');

function write(filePath, content) {
  const fullPath = path.join(__dirname, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim() + '\n', 'utf8');
  console.log('Created:', filePath);
}

// 1. src/db/schema.ts
write('src/db/schema.ts', `import { pgTable, uuid, text, timestamp, doublePrecision, integer, jsonb, uniqueIndex, index, sql } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const connectedAccounts = pgTable('connected_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  scopes: text('scopes').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const metricEntries = pgTable('metric_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  metricType: text('metric_type').notNull(),
  externalId: text('external_id'),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  valueNumeric: doublePrecision('value_numeric'),
  valueText: text('value_text'),
  unit: text('unit').notNull(),
  sourceStream: text('source_stream').notNull(), // 'raw' | 'reconciled'
  aggregation: text('aggregation').default('raw').notNull(),
  rawPayload: jsonb('raw_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('raw_stream_external_id_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.externalId)
    .where(sql\`external_id IS NOT NULL\`),
  uniqueIndex('reconciled_stream_interval_idx')
    .on(table.userId, table.provider, table.metricType, table.sourceStream, table.startTime, table.endTime)
    .where(sql\`external_id IS NULL\`),
  index('canonical_query_idx').on(table.userId, table.metricType, table.startTime, table.endTime),
]);

export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  metricType: text('metric_type'),
  trigger: text('trigger').notNull(),
  requestedRangeStart: timestamp('requested_range_start', { withTimezone: true }),
  requestedRangeEnd: timestamp('requested_range_end', { withTimezone: true }),
  status: text('status').notNull(),
  pointsFetched: integer('points_fetched').default(0).notNull(),
  pointsUpserted: integer('points_upserted').default(0).notNull(),
  pagesFetched: integer('pages_fetched').default(0).notNull(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
`);

// 2. src/db/index.ts
write('src/db/index.ts', `import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/health_dashboard',
});

export const db = drizzle(pool, { schema });
export { pool };
`);

// 3. src/services/cryptoService.ts
write('src/services/cryptoService.ts', `import crypto from 'crypto';

function getEncryptionKey(): Buffer {
  const hexKey = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  if (hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hexKey, 'hex');
}

export function encryptToken(plainText: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return JSON.stringify({
    iv: iv.toString('hex'),
    content: encrypted,
    tag: authTag
  });
}

export function decryptToken(encryptedJson: string): string {
  const key = getEncryptionKey();
  const { iv, content, tag } = JSON.parse(encryptedJson);
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  
  let decrypted = decipher.update(content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function signState(payload: object): string {
  const key = getEncryptionKey();
  const data = JSON.stringify({
    ...payload,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now()
  });
  const base64Data = Buffer.from(data).toString('base64url');
  const hmac = crypto.createHmac('sha256', key).update(base64Data).digest('base64url');
  return \`\${base64Data}.\${hmac}\`;
}

export function verifyState<T = any>(signedStateToken: string): T {
  const key = getEncryptionKey();
  const parts = signedStateToken.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid state token format');
  }
  const [base64Data, providedHmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', key).update(base64Data).digest('base64url');
  
  if (!crypto.timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac))) {
    throw new Error('State token HMAC verification failed (CSRF risk)');
  }
  
  const jsonStr = Buffer.from(base64Data, 'base64url').toString('utf8');
  return JSON.parse(jsonStr) as T;
}
`);

// 4. src/adapters/baseAdapter.ts
write('src/adapters/baseAdapter.ts', `export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  scopes: string[];
}

export interface SyncParams {
  userId: string;
  startDate: Date;
  endDate: Date;
  metricTypes?: string[];
}

export interface SyncResult {
  syncRunId: string;
  pointsFetched: number;
  pointsUpserted: number;
  status: 'completed' | 'failed';
  error?: string;
}

export interface NormalizedMetricEntry {
  userId: string;
  provider: string;
  metricType: string;
  externalId?: string;
  startTime: Date;
  endTime: Date;
  valueNumeric?: number;
  valueText?: string;
  unit: string;
  sourceStream: 'raw' | 'reconciled';
  aggregation: string;
  rawPayload?: any;
}

export interface ProviderAdapter {
  providerName: string;
  getAuthUrl(signedState: string): string;
  authenticate(code: string, redirectUri: string): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  sync(params: SyncParams): Promise<SyncResult>;
  mapToNormalizedSchema(rawPoint: any): NormalizedMetricEntry[];
}
`);

// 5. src/adapters/googleHealthAdapter.ts
write('src/adapters/googleHealthAdapter.ts', `import { ProviderAdapter, OAuthTokens, SyncParams, SyncResult, NormalizedMetricEntry } from './baseAdapter';

export class GoogleHealthAdapter implements ProviderAdapter {
  public providerName = 'google_health';

  public static SCOPES = [
    'openid',
    'email',
    'profile',
    'activity_and_fitness',
    'health_metrics_and_measurements'
  ];

  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(clientId?: string, clientSecret?: string, redirectUri?: string) {
    this.clientId = clientId || process.env.GOOGLE_CLIENT_ID || 'mock-client-id';
    this.clientSecret = clientSecret || process.env.GOOGLE_CLIENT_SECRET || 'mock-client-secret';
    this.redirectUri = redirectUri || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/connect/google/callback';
  }

  public getAuthUrl(signedState: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GoogleHealthAdapter.SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: signedState,
    });
    return \`https://accounts.google.com/o/oauth2/v2/auth?\${params.toString()}\`;
  }

  public async authenticate(code: string, redirectUri?: string): Promise<OAuthTokens> {
    // In production, exchanges code with https://oauth2.googleapis.com/token
    // Returns mock tokens if mock credentials configured
    if (this.clientId === 'mock-client-id') {
      return {
        accessToken: \`mock_access_token_\${code}\`,
        refreshToken: \`mock_refresh_token_\${code}\`,
        expiresIn: 3600,
        scopes: GoogleHealthAdapter.SCOPES,
      };
    }
    
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri || this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(\`Google OAuth token exchange failed: \${errorText}\`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scopes: data.scope ? data.scope.split(' ') : GoogleHealthAdapter.SCOPES,
    };
  }

  public async refreshToken(refreshToken: string): Promise<OAuthTokens> {
    if (this.clientId === 'mock-client-id') {
      return {
        accessToken: \`mock_refreshed_access_token_\${Date.now()}\`,
        refreshToken,
        expiresIn: 3600,
        scopes: GoogleHealthAdapter.SCOPES,
      };
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error('Google OAuth refresh token failed');
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
      scopes: data.scope ? data.scope.split(' ') : GoogleHealthAdapter.SCOPES,
    };
  }

  public async sync(params: SyncParams): Promise<SyncResult> {
    return {
      syncRunId: 'mock-sync-run-id',
      pointsFetched: 0,
      pointsUpserted: 0,
      status: 'completed',
    };
  }

  public mapToNormalizedSchema(rawPoint: any): NormalizedMetricEntry[] {
    return [{
      userId: rawPoint.userId,
      provider: this.providerName,
      metricType: rawPoint.metricType || 'heart_rate',
      externalId: rawPoint.id,
      startTime: new Date(rawPoint.startTime),
      endTime: new Date(rawPoint.endTime),
      valueNumeric: rawPoint.value,
      unit: rawPoint.unit || 'bpm',
      sourceStream: rawPoint.sourceStream || 'raw',
      aggregation: rawPoint.aggregation || 'raw',
      rawPayload: rawPoint,
    }];
  }
}
`);

// 6. src/services/metricsQueryService.ts
write('src/services/metricsQueryService.ts', `import { NormalizedMetricEntry } from '../adapters/baseAdapter';

export interface MetricQueryFilter {
  userId: string;
  metricType: string;
  startTime: Date;
  endTime: Date;
}

export function filterReconciledOverRaw(entries: NormalizedMetricEntry[]): NormalizedMetricEntry[] {
  // Sort entries: reconciled stream comes first so it overrides raw stream for overlapping times
  const activeEntries = entries.filter(e => !(e as any).deletedAt);

  const reconciledMap = new Map<string, NormalizedMetricEntry>();
  const rawEntries: NormalizedMetricEntry[] = [];

  for (const entry of activeEntries) {
    if (entry.sourceStream === 'reconciled') {
      const key = \`\${entry.startTime.toISOString()}-\${entry.endTime.toISOString()}\`;
      reconciledMap.set(key, entry);
    } else {
      rawEntries.push(entry);
    }
  }

  const result: NormalizedMetricEntry[] = Array.from(reconciledMap.values());

  for (const raw of rawEntries) {
    const rawKey = \`\${raw.startTime.toISOString()}-\${raw.endTime.toISOString()}\`;
    if (!reconciledMap.has(rawKey)) {
      result.push(raw);
    }
  }

  return result.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
`);

console.log('Core files generated.');
