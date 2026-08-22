import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users, metricDefinitions } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  logManualEntry,
  updateManualEntry,
  deleteManualEntry,
  createDefinitionAndLogFirstEntry,
} from '../src/services/manualEntryService';
import { createMetricDefinition } from '../src/services/metricDefinitionService';
import { queryMetricEntriesFromDb } from '../src/services/metricsQueryService';
import { ValidationError, NotFoundError } from '../src/errors/AppError';

describe('Phase 3 - Manual Metric Entries', () => {
  let testUserId: string;
  let otherUserId: string;
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

    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'manual_entry_tester@example.com',
      'manual_entry_other@example.com',
    ]).catch(() => {});

    const [user1] = await db
      .insert(users)
      .values({
        email: 'manual_entry_tester@example.com',
        passwordHash: 'hash_manual_123',
      })
      .returning();

    const [user2] = await db
      .insert(users)
      .values({
        email: 'manual_entry_other@example.com',
        passwordHash: 'hash_manual_456',
      })
      .returning();

    testUserId = user1.id;
    otherUserId = user2.id;
    authToken = jwt.sign({ id: testUserId, email: 'manual_entry_tester@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
    }
    if (otherUserId) {
      await db.delete(users).where(eq(users.id, otherUserId)).catch(() => {});
    }
  });

  describe('Service Layer Logic & Storage Columns', () => {
    test('logs numeric manual entry: stores in value_numeric, value_text is null', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'water-intake-manual',
        displayName: 'Water Intake',
        valueType: 'numeric',
        unit: 'ml',
      });

      const now = new Date('2026-08-22T10:00:00Z');
      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'water-intake-manual',
        startTime: now,
        valueNumeric: 750.5,
        unit: 'ml',
      });

      expect(entry.provider).toBe('manual');
      expect(entry.metricType).toBe('water-intake-manual');
      expect(entry.valueNumeric).toBe(750.5);
      expect(entry.valueText).toBeNull();
      expect(entry.unit).toBe('ml');
      expect(entry.sourceStream).toBeNull();
      expect(entry.externalId).toBeNull();
    });

    test('logs duration manual entry: stores seconds in value_numeric, value_text is null', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'meditation-manual',
        displayName: 'Meditation',
        valueType: 'duration',
        unit: 'seconds',
      });

      const now = new Date('2026-08-22T10:00:00Z');
      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'meditation-manual',
        startTime: now,
        valueNumeric: 1200, // 20 minutes in seconds
      });

      expect(entry.valueNumeric).toBe(1200);
      expect(entry.valueText).toBeNull();
      expect(entry.unit).toBe('seconds');
    });

    test('logs boolean manual entry: stores 0 or 1 in value_numeric, value_text and unit are null', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'took-creatine-manual',
        displayName: 'Took Creatine',
        valueType: 'boolean',
      });

      const now = new Date('2026-08-22T10:00:00Z');
      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'took-creatine-manual',
        startTime: now,
        valueNumeric: 1,
      });

      expect(entry.valueNumeric).toBe(1);
      expect(entry.valueText).toBeNull();
      expect(entry.unit).toBeNull();
    });

    test('logs category manual entry: stores string label in value_text, value_numeric and unit are null', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'mood-manual',
        displayName: 'Daily Mood',
        valueType: 'category',
        categoryValues: ['Calm', 'Energetic', 'Tired'],
      });

      const now = new Date('2026-08-22T10:00:00Z');
      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'mood-manual',
        startTime: now,
        valueText: 'Energetic',
      });

      expect(entry.valueText).toBe('Energetic');
      expect(entry.valueNumeric).toBeNull();
      expect(entry.unit).toBeNull();
    });

    test('rejects category value not in allowed list', async () => {
      const now = new Date('2026-08-22T10:00:00Z');
      await expect(
        logManualEntry({
          userId: testUserId,
          metricType: 'mood-manual',
          startTime: now,
          valueText: 'Angry', // not in allowed list
        })
      ).rejects.toThrow(ValidationError);
    });

    test('blocks logging new entries against an archived definition', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'archived-tracker-manual',
        displayName: 'Archived Tracker',
        valueType: 'numeric',
        unit: 'units',
      });

      await db
        .update(metricDefinitions)
        .set({ archivedAt: new Date() })
        .where(eq(metricDefinitions.id, def.id));

      const now = new Date('2026-08-22T10:00:00Z');
      await expect(
        logManualEntry({
          userId: testUserId,
          metricType: 'archived-tracker-manual',
          startTime: now,
          valueNumeric: 10,
        })
      ).rejects.toThrow(ValidationError);
    });

    test('rejects logging against another user definition (ownership protection / 404)', async () => {
      // Create definition owned by otherUserId
      await createMetricDefinition({
        userId: otherUserId,
        metricType: 'other-user-tracker',
        displayName: 'Other User Tracker',
        valueType: 'numeric',
        unit: 'units',
      });

      const now = new Date('2026-08-22T10:00:00Z');
      await expect(
        logManualEntry({
          userId: testUserId, // testUserId tries to log against otherUserId's definition
          metricType: 'other-user-tracker',
          startTime: now,
          valueNumeric: 10,
        })
      ).rejects.toThrow(NotFoundError);
    });

    test('allows updating historical manual entries against an archived definition', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'historical-edit-test',
        displayName: 'Historical Edit Test',
        valueType: 'numeric',
        unit: 'count',
      });

      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'historical-edit-test',
        startTime: new Date('2026-08-20T10:00:00Z'),
        valueNumeric: 5,
      });

      // Now archive definition
      await db
        .update(metricDefinitions)
        .set({ archivedAt: new Date() })
        .where(eq(metricDefinitions.id, def.id));

      // Updating historical entry should succeed
      const updated = await updateManualEntry({
        id: entry.id,
        userId: testUserId,
        valueNumeric: 8,
      });

      expect(updated.valueNumeric).toBe(8);
    });

    test('soft-deletes manual entry and removes from active query', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'query-filter-test',
        displayName: 'Query Filter Test',
        valueType: 'numeric',
        unit: 'pts',
      });

      const startTime = new Date('2026-08-22T11:00:00Z');
      const endTime = new Date('2026-08-22T11:30:00Z');

      const entry = await logManualEntry({
        userId: testUserId,
        metricType: 'query-filter-test',
        startTime,
        endTime,
        valueNumeric: 42,
      });

      // Query metrics from DB — should return 1 entry
      const queriedBefore = await queryMetricEntriesFromDb({
        userId: testUserId,
        metricType: 'query-filter-test',
        startTime: new Date('2026-08-22T00:00:00Z'),
        endTime: new Date('2026-08-22T23:59:59Z'),
      });
      expect(queriedBefore.length).toBe(1);
      expect(queriedBefore[0].valueNumeric).toBe(42);

      // Soft delete
      const delResult = await deleteManualEntry(entry.id, testUserId);
      expect(delResult.success).toBe(true);

      // Query metrics from DB — should now return 0 active entries
      const queriedAfter = await queryMetricEntriesFromDb({
        userId: testUserId,
        metricType: 'query-filter-test',
        startTime: new Date('2026-08-22T00:00:00Z'),
        endTime: new Date('2026-08-22T23:59:59Z'),
      });
      expect(queriedAfter.length).toBe(0);
    });
  });

  describe('Combined Transaction Flow', () => {
    test('createDefinitionAndLogFirstEntry succeeds atomically', async () => {
      const result = await createDefinitionAndLogFirstEntry(
        {
          definition: {
            userId: testUserId,
            metricType: 'coffee-cups-tx',
            displayName: 'Coffee Cups',
            valueType: 'numeric',
            unit: 'cups',
          },
          entry: {
            startTime: new Date('2026-08-22T08:30:00Z'),
            valueNumeric: 2,
            unit: 'cups',
          },
        },
        testUserId
      );

      expect(result.definition.metricType).toBe('coffee-cups-tx');
      expect(result.entry.metricType).toBe('coffee-cups-tx');
      expect(result.entry.valueNumeric).toBe(2);
      expect(result.entry.provider).toBe('manual');
    });

    test('createDefinitionAndLogFirstEntry rolls back if entry logging fails', async () => {
      await expect(
        createDefinitionAndLogFirstEntry(
          {
            definition: {
              userId: testUserId,
              metricType: 'failed-tx-tracker',
              displayName: 'Failed TX Tracker',
              valueType: 'numeric',
              unit: 'units',
            },
            entry: {
              startTime: new Date('2026-08-22T08:30:00Z'),
              valueNumeric: null, // Invalid for numeric type!
            },
          },
          testUserId
        )
      ).rejects.toThrow(ValidationError);

      // Verify definition was rolled back
      const [found] = await db
        .select()
        .from(metricDefinitions)
        .where(eq(metricDefinitions.metricType, 'failed-tx-tracker'));

      expect(found).toBeUndefined();
    });
  });

  describe('HTTP API Endpoints (/api/metric-entries)', () => {
    let loggedEntryId: string;

    test('POST /api/metric-entries/manual logs manual entry successfully', async () => {
      await createMetricDefinition({
        userId: testUserId,
        metricType: 'water-intake-api',
        displayName: 'Water Intake API',
        valueType: 'numeric',
        unit: 'ml',
      });

      const res = await request(app)
        .post('/api/metric-entries/manual')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          metric_type: 'water-intake-api',
          start_time: new Date().toISOString(),
          value_numeric: 500,
          unit: 'ml',
        });

      expect(res.status).toBe(201);
      expect(res.body.metricEntry).toHaveProperty('id');
      expect(res.body.metricEntry.provider).toBe('manual');
      expect(res.body.metricEntry.valueNumeric).toBe(500);
      loggedEntryId = res.body.metricEntry.id;
    });

    test('POST /api/metric-entries/manual/combined creates definition and logs entry', async () => {
      const res = await request(app)
        .post('/api/metric-entries/manual/combined')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          definition: {
            metric_type: 'alcohol-units-api',
            display_name: 'Alcohol Units',
            value_type: 'numeric',
            unit: 'units',
          },
          entry: {
            start_time: new Date().toISOString(),
            value_numeric: 2,
            unit: 'units',
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.metricDefinition.metricType).toBe('alcohol-units-api');
      expect(res.body.metricEntry.metricType).toBe('alcohol-units-api');
      expect(res.body.metricEntry.valueNumeric).toBe(2);
    });

    test('PATCH /api/metric-entries/manual/:id updates entry', async () => {
      const res = await request(app)
        .patch(`/api/metric-entries/manual/${loggedEntryId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          value_numeric: 650,
        });

      expect(res.status).toBe(200);
      expect(res.body.metricEntry.valueNumeric).toBe(650);
    });

    test('DELETE /api/metric-entries/manual/:id soft-deletes entry', async () => {
      const res = await request(app)
        .delete(`/api/metric-entries/manual/${loggedEntryId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('DELETE /api/metric-entries/manual/:id returns 404 for non-existent entry', async () => {
      const res = await request(app)
        .delete('/api/metric-entries/manual/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND_ERROR');
    });
  });
});
