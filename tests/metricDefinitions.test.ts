import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users, metricEntries } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  createMetricDefinition,
  updateMetricDefinition,
  archiveMetricDefinition,
  deleteMetricDefinition,
  validateMetricTypeFormat,
  validateCategoryValues,
} from '../src/services/metricDefinitionService';
import { ValidationError } from '../src/errors/AppError';

describe('Phase 3 - Metric Definitions & Custom Metrics', () => {
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

    await pool.query('DELETE FROM users WHERE email = $1', ['metric_defs_test@example.com']).catch(() => {});

    const [createdUser] = await db
      .insert(users)
      .values({
        email: 'metric_defs_test@example.com',
        passwordHash: 'hash_test_123',
      })
      .returning();

    testUserId = createdUser.id;
    authToken = jwt.sign({ id: testUserId, email: 'metric_defs_test@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
    }
  });

  describe('Validation & Format Rules', () => {
    test('enforces strict kebab-case on metric_type with clear error message', () => {
      expect(() => validateMetricTypeFormat('waterIntake', testUserId)).toThrow(ValidationError);
      expect(() => validateMetricTypeFormat('water_intake', testUserId)).toThrow(ValidationError);
      expect(() => validateMetricTypeFormat('Water-Intake', testUserId)).toThrow(ValidationError);
      expect(() => validateMetricTypeFormat('water--intake', testUserId)).toThrow(ValidationError);
      expect(() => validateMetricTypeFormat('-water-intake', testUserId)).toThrow(ValidationError);

      try {
        validateMetricTypeFormat('WaterIntake', testUserId);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ValidationError);
        const valErr = err as ValidationError;
        expect(valErr.message).toContain('kebab-case');
      }

      // Valid kebab-case should pass
      expect(() => validateMetricTypeFormat('water-intake', testUserId)).not.toThrow();
      expect(() => validateMetricTypeFormat('caffeine-mg-2', testUserId)).not.toThrow();
    });

    test('rejects reserved system provider metric types derived from adapters', () => {
      const reserved = ['steps', 'heart-rate', 'heart_rate', 'active-zone-minutes', 'sleep', 'blood-pressure', 'weight', 'google_health', 'manual'];
      for (const key of reserved) {
        expect(() => validateMetricTypeFormat(key, testUserId)).toThrow(ValidationError);
      }
    });

    test('validates category_values: rejects empty arrays, empty strings, and duplicates', () => {
      expect(() => validateCategoryValues([], testUserId, 'test')).toThrow(ValidationError);
      expect(() => validateCategoryValues([''], testUserId, 'test')).toThrow(ValidationError);
      expect(() => validateCategoryValues(['   '], testUserId, 'test')).toThrow(ValidationError);
      expect(() => validateCategoryValues(['good', 'good'], testUserId, 'test')).toThrow(ValidationError);
      expect(() => validateCategoryValues(['Good', 'good'], testUserId, 'test')).toThrow(ValidationError);

      const valid = validateCategoryValues(['None', 'Mild', 'Severe'], testUserId, 'test');
      expect(valid).toEqual(['None', 'Mild', 'Severe']);
    });

    test('AppError JSON serialization safety (Rule #2)', () => {
      const err = new ValidationError('Testing serialization', { userId: testUserId });
      const json = JSON.parse(JSON.stringify(err));
      expect(json.message).toBe('Testing serialization');
      expect(json.name).toBe('ValidationError');
      expect(json.code).toBe('VALIDATION_ERROR');
      expect(json.statusCode).toBe(400);
    });
  });

  describe('Service Layer & Storage Mapping', () => {
    test('creates numeric definition with required unit', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'water-intake-test',
        displayName: 'Water Intake',
        valueType: 'numeric',
        unit: 'ml',
      });

      expect(def.metricType).toBe('water-intake-test');
      expect(def.valueType).toBe('numeric');
      expect(def.unit).toBe('ml');
      expect(def.categoryValues).toBeNull();
    });

    test('creates duration definition with required unit', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'meditation-time-test',
        displayName: 'Meditation Time',
        valueType: 'duration',
        unit: 'seconds',
      });

      expect(def.valueType).toBe('duration');
      expect(def.unit).toBe('seconds');
    });

    test('creates boolean definition with null unit', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'took-vitamins-test',
        displayName: 'Took Daily Vitamins',
        valueType: 'boolean',
      });

      expect(def.valueType).toBe('boolean');
      expect(def.unit).toBeNull();
    });

    test('creates category definition with validated category_values and null unit', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'headache-severity-test',
        displayName: 'Headache Severity',
        valueType: 'category',
        categoryValues: ['Mild', 'Moderate', 'Severe'],
      });

      expect(def.valueType).toBe('category');
      expect(def.categoryValues).toEqual(['Mild', 'Moderate', 'Severe']);
      expect(def.unit).toBeNull();
    });

    test('rejects duplicate metric_type with PG 23505 converted to ValidationError', async () => {
      await expect(
        createMetricDefinition({
          userId: testUserId,
          metricType: 'water-intake-test',
          displayName: 'Duplicate Water Intake',
          valueType: 'numeric',
          unit: 'ml',
        })
      ).rejects.toThrow(ValidationError);
    });

    test('rejects numeric definition without unit', async () => {
      await expect(
        createMetricDefinition({
          userId: testUserId,
          metricType: 'water-intake-no-unit',
          displayName: 'Water Intake',
          valueType: 'numeric',
          unit: '',
        })
      ).rejects.toThrow(ValidationError);
    });

    test('rejects boolean definition with non-null unit', async () => {
      await expect(
        createMetricDefinition({
          userId: testUserId,
          metricType: 'took-vitamins-with-unit',
          displayName: 'Took Vitamins',
          valueType: 'boolean',
          unit: 'count',
        })
      ).rejects.toThrow(ValidationError);
    });

    test('immutability: locks value_type and unit once metric_entries exist', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'immutability-check',
        displayName: 'Immutability Check',
        valueType: 'numeric',
        unit: 'count',
      });

      // Insert an entry for this metricType
      await db.insert(metricEntries).values({
        userId: testUserId,
        provider: 'manual',
        metricType: 'immutability-check',
        startTime: new Date(),
        endTime: new Date(),
        valueNumeric: 5,
        unit: 'count',
        dimension: 'default',
        aggregation: 'raw',
      });

      // Updating display_name is allowed
      const updated = await updateMetricDefinition({
        id: def.id,
        userId: testUserId,
        displayName: 'Renamed Immutability Check',
      });
      expect(updated.displayName).toBe('Renamed Immutability Check');

      // Attempting to change valueType or unit must be rejected
      await expect(
        updateMetricDefinition({
          id: def.id,
          userId: testUserId,
          unit: 'new-unit',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        updateMetricDefinition({
          id: def.id,
          userId: testUserId,
          valueType: 'duration',
        })
      ).rejects.toThrow(ValidationError);
    });

    test('delete vs archive: cannot delete definition with existing entries, archive succeeds', async () => {
      const def = await createMetricDefinition({
        userId: testUserId,
        metricType: 'delete-vs-archive',
        displayName: 'Delete vs Archive',
        valueType: 'numeric',
        unit: 'points',
      });

      // With 0 entries, delete succeeds
      const delResult = await deleteMetricDefinition(def.id, testUserId);
      expect(delResult.success).toBe(true);

      // Recreate and add an entry
      const def2 = await createMetricDefinition({
        userId: testUserId,
        metricType: 'delete-vs-archive-2',
        displayName: 'Delete vs Archive 2',
        valueType: 'numeric',
        unit: 'points',
      });

      await db.insert(metricEntries).values({
        userId: testUserId,
        provider: 'manual',
        metricType: 'delete-vs-archive-2',
        startTime: new Date(),
        endTime: new Date(),
        valueNumeric: 10,
        unit: 'points',
        dimension: 'default',
        aggregation: 'raw',
      });

      // Delete must fail
      await expect(deleteMetricDefinition(def2.id, testUserId)).rejects.toThrow(ValidationError);

      // Archive succeeds
      const archived = await archiveMetricDefinition(def2.id, testUserId);
      expect(archived.archivedAt).not.toBeNull();
    });
  });

  describe('HTTP API Endpoints (/api/metric-definitions)', () => {
    let apiDefId: string;

    test('POST /api/metric-definitions creates a definition', async () => {
      const res = await request(app)
        .post('/api/metric-definitions')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          metric_type: 'daily-mood-api',
          display_name: 'Daily Mood',
          value_type: 'category',
          category_values: ['Happy', 'Neutral', 'Sad'],
        });

      expect(res.status).toBe(201);
      expect(res.body.metricDefinition).toHaveProperty('id');
      expect(res.body.metricDefinition.metricType).toBe('daily-mood-api');
      expect(res.body.metricDefinition.valueType).toBe('category');
      expect(res.body.metricDefinition.categoryValues).toEqual(['Happy', 'Neutral', 'Sad']);
      apiDefId = res.body.metricDefinition.id;
    });

    test('POST /api/metric-definitions rejects unauthenticated request', async () => {
      const res = await request(app)
        .post('/api/metric-definitions')
        .send({
          metric_type: 'daily-mood-api-2',
          display_name: 'Daily Mood',
          value_type: 'category',
        });

      expect(res.status).toBe(401);
    });

    test('POST /api/metric-definitions rejects invalid payload with Zod 400', async () => {
      const res = await request(app)
        .post('/api/metric-definitions')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          metric_type: 'invalid_snake_case',
          display_name: 'Daily Mood',
          value_type: 'invalid_type',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    test('GET /api/metric-definitions lists definitions', async () => {
      const res = await request(app)
        .get('/api/metric-definitions')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.metricDefinitions)).toBe(true);
      expect(res.body.metricDefinitions.length).toBeGreaterThan(0);
    });

    test('GET /api/metric-definitions/:id returns definition', async () => {
      const res = await request(app)
        .get(`/api/metric-definitions/${apiDefId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.metricDefinition.id).toBe(apiDefId);
    });

    test('PATCH /api/metric-definitions/:id updates display_name', async () => {
      const res = await request(app)
        .patch(`/api/metric-definitions/${apiDefId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ display_name: 'Updated Mood Tracker' });

      expect(res.status).toBe(200);
      expect(res.body.metricDefinition.displayName).toBe('Updated Mood Tracker');
    });

    test('POST /api/metric-definitions/:id/archive archives definition', async () => {
      const res = await request(app)
        .post(`/api/metric-definitions/${apiDefId}/archive`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.metricDefinition.archivedAt).not.toBeNull();
    });

    test('DELETE /api/metric-definitions/:id deletes definition when 0 entries exist', async () => {
      const createRes = await request(app)
        .post('/api/metric-definitions')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          metric_type: 'to-be-deleted',
          display_name: 'To Be Deleted',
          value_type: 'numeric',
          unit: 'count',
        });

      const toDeleteId = createRes.body.metricDefinition.id;

      const res = await request(app)
        .delete(`/api/metric-definitions/${toDeleteId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
