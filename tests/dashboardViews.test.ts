import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { db, pool } from '../src/db';
import { users } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  createDashboardView,
  listDashboardViews,
  getDashboardView,
  updateDashboardView,
  deleteDashboardView,
} from '../src/services/dashboardViewService';
import { ValidationError, NotFoundError } from '../src/errors/AppError';

describe('Phase 5 - Dashboard Views & Multi-Metric Config', () => {
  let testUserId: string;
  let otherUserId: string;
  let authToken: string;

  beforeAll(async () => {
    // Idempotent schema bootstrap
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dashboard_views_user_name_idx 
        ON dashboard_views (user_id, name);
    `).catch(() => {});

    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'dashboard_view_tester@example.com',
      'dashboard_view_other@example.com',
    ]).catch(() => {});

    const [user1] = await db
      .insert(users)
      .values({
        email: 'dashboard_view_tester@example.com',
        passwordHash: 'hash_dashboard_123',
      })
      .returning();

    const [user2] = await db
      .insert(users)
      .values({
        email: 'dashboard_view_other@example.com',
        passwordHash: 'hash_dashboard_456',
      })
      .returning();

    testUserId = user1.id;
    otherUserId = user2.id;
    authToken = jwt.sign({ id: testUserId, email: 'dashboard_view_tester@example.com' }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId)).catch(() => {});
    }
    if (otherUserId) {
      await db.delete(users).where(eq(users.id, otherUserId)).catch(() => {});
    }
  });

  describe('Service Layer & Zod Config Validation', () => {
    test('creates dashboard view with relative timeRange', async () => {
      const view = await createDashboardView({
        userId: testUserId,
        name: 'Cardio & Recovery',
        config: {
          panels: [
            {
              id: 'panel-1',
              metricTypes: ['heart-rate', 'daily-resting-heart-rate'],
              timeRange: { type: 'relative', value: 'last_7d' },
              aggregation: '5m_avg',
              chartType: 'line',
            },
          ],
        },
      });

      expect(view).toBeDefined();
      expect(view.id).toBeDefined();
      expect(view.name).toBe('Cardio & Recovery');
      expect(view.config.panels).toHaveLength(1);
      expect(view.config.panels[0].metricTypes).toEqual(['heart-rate', 'daily-resting-heart-rate']);
    });

    test('creates dashboard view with absolute timeRange', async () => {
      const view = await createDashboardView({
        userId: testUserId,
        name: 'Marathon Training Week',
        config: {
          panels: [
            {
              id: 'panel-abs',
              metricTypes: ['steps', 'run-vo2-max'],
              timeRange: {
                type: 'absolute',
                startTime: '2026-08-01T00:00:00.000Z',
                endTime: '2026-08-07T23:59:59.000Z',
              },
              aggregation: 'daily_avg',
              chartType: 'bar',
            },
          ],
        },
      });

      expect(view.name).toBe('Marathon Training Week');
      expect(view.config.panels[0].timeRange.type).toBe('absolute');
    });

    test('rejects creation with empty metricTypes', async () => {
      await expect(
        createDashboardView({
          userId: testUserId,
          name: 'Invalid Empty Metrics View',
          config: {
            panels: [
              {
                id: 'panel-empty',
                metricTypes: [],
                timeRange: { type: 'relative', value: 'last_30d' },
                aggregation: 'raw',
              },
            ],
          },
        })
      ).rejects.toThrow();
    });

    test('rejects creation with invalid relative timeRange value (e.g. custom in relative enum)', async () => {
      await expect(
        createDashboardView({
          userId: testUserId,
          name: 'Invalid TimeRange',
          config: {
            panels: [
              {
                id: 'panel-bad',
                metricTypes: ['steps'],
                // @ts-expect-error testing invalid runtime enum
                timeRange: { type: 'relative', value: 'custom' },
                aggregation: 'raw',
              },
            ],
          },
        })
      ).rejects.toThrow();
    });

    test('rejects creation with duplicate view name for same user (PG 23505 -> ValidationError)', async () => {
      await expect(
        createDashboardView({
          userId: testUserId,
          name: 'Cardio & Recovery',
          config: {
            panels: [
              {
                id: 'p-dup',
                metricTypes: ['steps'],
                timeRange: { type: 'relative', value: 'last_7d' },
                aggregation: 'raw',
              },
            ],
          },
        })
      ).rejects.toThrow(ValidationError);
    });

    test('allows same view name for a different user (ownership isolation)', async () => {
      const otherView = await createDashboardView({
        userId: otherUserId,
        name: 'Cardio & Recovery',
        config: {
          panels: [
            {
              id: 'panel-other',
              metricTypes: ['heart-rate'],
              timeRange: { type: 'relative', value: 'last_24h' },
              aggregation: '1m_avg',
            },
          ],
        },
      });

      expect(otherView.userId).toBe(otherUserId);
      expect(otherView.name).toBe('Cardio & Recovery');
    });

    test('lists views for specific user only', async () => {
      const views = await listDashboardViews(testUserId);
      expect(views.length).toBeGreaterThanOrEqual(2);
      expect(views.every((v) => v.userId === testUserId)).toBe(true);
    });

    test('getDashboardView returns view by id and blocks cross-user access (404)', async () => {
      const views = await listDashboardViews(otherUserId);
      const otherViewId = views[0].id;

      // testUser cannot access otherUser's view
      await expect(getDashboardView(otherViewId, testUserId)).rejects.toThrow(NotFoundError);

      // otherUser can access their own view
      const view = await getDashboardView(otherViewId, otherUserId);
      expect(view.id).toBe(otherViewId);
    });

    test('updateDashboardView updates name and config', async () => {
      const views = await listDashboardViews(testUserId);
      const viewToUpdate = views[0];

      const updated = await updateDashboardView({
        id: viewToUpdate.id,
        userId: testUserId,
        name: 'Updated View Name',
        config: {
          panels: [
            {
              id: 'panel-upd',
              metricTypes: ['heart-rate', 'hydration-log'],
              timeRange: { type: 'relative', value: 'last_90d' },
              aggregation: 'daily_avg',
            },
          ],
        },
      });

      expect(updated.name).toBe('Updated View Name');
      expect(updated.config.panels[0].timeRange).toEqual({ type: 'relative', value: 'last_90d' });
    });

    test('updateDashboardView rejects renaming to an existing name of same user (PG 23505 -> ValidationError)', async () => {
      const views = await listDashboardViews(testUserId);
      expect(views.length).toBeGreaterThanOrEqual(2);

      const viewA = views[0];
      const viewB = views[1];

      // Try to rename viewB to viewA's name
      await expect(
        updateDashboardView({
          id: viewB.id,
          userId: testUserId,
          name: viewA.name,
        })
      ).rejects.toThrow(ValidationError);
    });

    test('deleteDashboardView deletes view and blocks non-owner delete', async () => {
      const toDelete = await createDashboardView({
        userId: testUserId,
        name: 'To Be Deleted View',
        config: {
          panels: [
            {
              id: 'p-del',
              metricTypes: ['steps'],
              timeRange: { type: 'relative', value: 'last_7d' },
              aggregation: 'raw',
            },
          ],
        },
      });

      // otherUser cannot delete testUser's view
      await expect(deleteDashboardView(toDelete.id, otherUserId)).rejects.toThrow(NotFoundError);

      // owner can delete
      const res = await deleteDashboardView(toDelete.id, testUserId);
      expect(res.success).toBe(true);

      // subsequent get throws NotFoundError
      await expect(getDashboardView(toDelete.id, testUserId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('HTTP API Endpoints (/api/dashboard-views)', () => {
    let createdViewId: string;

    test('POST /api/dashboard-views creates a view', async () => {
      const res = await request(app)
        .post('/api/dashboard-views')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Sleep & Stress Overview',
          config: {
            panels: [
              {
                id: 'panel-sleep-stress',
                metricTypes: ['sleep', 'daily-resting-heart-rate', 'daily-heart-rate-variability'],
                timeRange: { type: 'relative', value: 'last_30d' },
                aggregation: 'daily_avg',
                chartType: 'line',
              },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.dashboardView).toBeDefined();
      expect(res.body.dashboardView.name).toBe('Sleep & Stress Overview');
      createdViewId = res.body.dashboardView.id;
    });

    test('POST /api/dashboard-views rejects unauthenticated request (401)', async () => {
      const res = await request(app)
        .post('/api/dashboard-views')
        .send({
          name: 'Unauth View',
          config: {
            panels: [
              {
                id: 'p1',
                metricTypes: ['steps'],
                timeRange: { type: 'relative', value: 'last_7d' },
                aggregation: 'raw',
              },
            ],
          },
        });

      expect(res.status).toBe(401);
    });

    test('POST /api/dashboard-views rejects invalid payload with 400', async () => {
      const res = await request(app)
        .post('/api/dashboard-views')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: '',
          config: { panels: [] },
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    test('GET /api/dashboard-views lists views for authenticated user', async () => {
      const res = await request(app)
        .get('/api/dashboard-views')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dashboardViews)).toBe(true);
      expect(res.body.dashboardViews.some((v: { id: string }) => v.id === createdViewId)).toBe(true);
    });

    test('GET /api/dashboard-views/:id returns single view', async () => {
      const res = await request(app)
        .get(`/api/dashboard-views/${createdViewId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.dashboardView.id).toBe(createdViewId);
    });

    test('PATCH /api/dashboard-views/:id updates view', async () => {
      const res = await request(app)
        .patch(`/api/dashboard-views/${createdViewId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Sleep, Stress & Mood Overview',
        });

      expect(res.status).toBe(200);
      expect(res.body.dashboardView.name).toBe('Sleep, Stress & Mood Overview');
    });

    test('DELETE /api/dashboard-views/:id deletes view', async () => {
      const res = await request(app)
        .delete(`/api/dashboard-views/${createdViewId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await request(app)
        .get(`/api/dashboard-views/${createdViewId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(check.status).toBe(404);
    });
  });
});
