import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users, metricDefinitions, metricEntries } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  queryEnrichedMetricEntries,
  queryBatchEnrichedMetrics,
} from '../src/services/metricsQueryService';
import { createMetricDefinition } from '../src/services/metricDefinitionService';
import { logManualEntry } from '../src/services/manualEntryService';

describe('Enriched Metrics Query Layer (Dashboard & Chart Reads)', () => {
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    await pool.query(`
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_numeric DOUBLE PRECISION;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_text TEXT;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_min DOUBLE PRECISION;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS value_max DOUBLE PRECISION;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS dimension TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS aggregation TEXT NOT NULL DEFAULT 'raw';
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS raw_payload JSONB;
      ALTER TABLE metric_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE metric_entries ALTER COLUMN unit DROP NOT NULL;
      ALTER TABLE metric_entries ALTER COLUMN source_stream DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS metric_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        value_type TEXT NOT NULL,
        unit TEXT,
        category_values JSONB,
        archived_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_user_metric_idx 
        ON metric_definitions (user_id, metric_type);
    `).catch(() => {});

    await pool.query('DELETE FROM users WHERE email = $1', ['enriched_query_tester@example.com']).catch(() => {});

    const [user] = await db
      .insert(users)
      .values({
        email: 'enriched_query_tester@example.com',
        passwordHash: 'hash_query_123',
      })
      .returning();

    testUserId = user.id;
    authToken = jwt.sign({ id: testUserId, email: 'enriched_query_tester@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
    }
  });

  test('resolves custom metric definition metadata (display_name, value_type, unit, category_values)', async () => {
    await createMetricDefinition({
      userId: testUserId,
      metricType: 'custom-symptom-level',
      displayName: 'Daily Symptom Level',
      valueType: 'category',
      categoryValues: ['Mild', 'Moderate', 'Severe'],
    });

    const now = new Date('2026-08-22T10:00:00Z');
    await logManualEntry({
      userId: testUserId,
      metricType: 'custom-symptom-level',
      startTime: now,
      valueText: 'Moderate',
    });

    const result = await queryEnrichedMetricEntries({
      userId: testUserId,
      metricType: 'custom-symptom-level',
      startTime: new Date('2026-08-22T00:00:00Z'),
      endTime: new Date('2026-08-22T23:59:59Z'),
    });

    expect(result.metricType).toBe('custom-symptom-level');
    expect(result.displayName).toBe('Daily Symptom Level');
    expect(result.valueType).toBe('category');
    expect(result.categoryValues).toEqual(['Mild', 'Moderate', 'Severe']);
    expect(result.isCustom).toBe(true);
    expect(result.isArchived).toBe(false);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].valueText).toBe('Moderate');
  });

  test('resolves archived custom metric metadata for historical chart rendering (no archived_at filter)', async () => {
    const def = await createMetricDefinition({
      userId: testUserId,
      metricType: 'retired-tracker',
      displayName: 'Retired Tracker',
      valueType: 'numeric',
      unit: 'pts',
    });

    const now = new Date('2026-08-20T10:00:00Z');
    await logManualEntry({
      userId: testUserId,
      metricType: 'retired-tracker',
      startTime: now,
      valueNumeric: 42,
      unit: 'pts',
    });

    // Soft-archive the definition
    await db
      .update(metricDefinitions)
      .set({ archivedAt: new Date() })
      .where(eq(metricDefinitions.id, def.id));

    // Query enriched metrics — MUST still resolve display_name, value_type, unit and historical entry
    const result = await queryEnrichedMetricEntries({
      userId: testUserId,
      metricType: 'retired-tracker',
      startTime: new Date('2026-08-20T00:00:00Z'),
      endTime: new Date('2026-08-20T23:59:59Z'),
    });

    expect(result.metricType).toBe('retired-tracker');
    expect(result.displayName).toBe('Retired Tracker');
    expect(result.valueType).toBe('numeric');
    expect(result.unit).toBe('pts');
    expect(result.isCustom).toBe(true);
    expect(result.isArchived).toBe(true);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].valueNumeric).toBe(42);
  });

  test('resolves canonical provider metric metadata for standard provider metrics', async () => {
    // Insert a synced provider entry for 'steps'
    await db.insert(metricEntries).values({
      userId: testUserId,
      provider: 'google_health',
      metricType: 'steps',
      externalId: 'ext_steps_1',
      startTime: new Date('2026-08-22T08:00:00Z'),
      endTime: new Date('2026-08-22T09:00:00Z'),
      valueNumeric: 3500,
      unit: 'count',
      dimension: 'default',
      sourceStream: 'reconciled',
      aggregation: '1h_sum',
    });

    const result = await queryEnrichedMetricEntries({
      userId: testUserId,
      metricType: 'steps',
      startTime: new Date('2026-08-22T00:00:00Z'),
      endTime: new Date('2026-08-22T23:59:59Z'),
    });

    expect(result.metricType).toBe('steps');
    expect(result.displayName).toBe('Steps');
    expect(result.valueType).toBe('numeric');
    expect(result.unit).toBe('count');
    expect(result.isCustom).toBe(false);
    expect(result.isArchived).toBe(false);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].valueNumeric).toBe(3500);
  });

  test('queryBatchEnrichedMetrics executes consolidated batch query without N+1', async () => {
    // We query multiple metrics: 'steps' (provider) and 'custom-symptom-level' (custom)
    const results = await queryBatchEnrichedMetrics({
      userId: testUserId,
      metricTypes: ['steps', 'custom-symptom-level', 'heart-rate'],
      startTime: new Date('2026-08-22T00:00:00Z'),
      endTime: new Date('2026-08-22T23:59:59Z'),
    });

    expect(results.length).toBe(3);

    const stepsRes = results.find((r) => r.metricType === 'steps')!;
    expect(stepsRes.displayName).toBe('Steps');
    expect(stepsRes.isCustom).toBe(false);

    const symptomRes = results.find((r) => r.metricType === 'custom-symptom-level')!;
    expect(symptomRes.displayName).toBe('Daily Symptom Level');
    expect(symptomRes.valueType).toBe('category');
    expect(symptomRes.isCustom).toBe(true);

    const hrRes = results.find((r) => r.metricType === 'heart-rate')!;
    expect(hrRes.displayName).toBe('Heart Rate');
    expect(hrRes.unit).toBe('bpm');
    expect(hrRes.entries.length).toBe(0); // None logged in this window
  });

  describe('HTTP Query API (GET /api/metric-entries)', () => {
    test('GET /api/metric-entries?metric_type=... returns single enriched metric', async () => {
      const res = await request(app)
        .get('/api/metric-entries')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          metric_type: 'custom-symptom-level',
          start_time: '2026-08-22T00:00:00.000Z',
          end_time: '2026-08-22T23:59:59.000Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Daily Symptom Level');
      expect(res.body.valueType).toBe('category');
      expect(Array.isArray(res.body.entries)).toBe(true);
    });

    test('GET /api/metric-entries?metric_types=... returns batch of enriched metrics', async () => {
      const res = await request(app)
        .get('/api/metric-entries')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          metric_types: 'steps,custom-symptom-level',
          start_time: '2026-08-22T00:00:00.000Z',
          end_time: '2026-08-22T23:59:59.000Z',
        });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.metrics)).toBe(true);
      expect(res.body.metrics.length).toBe(2);
    });
  });
});
