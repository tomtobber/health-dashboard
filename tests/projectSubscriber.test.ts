import { GoogleHealthAdapter, WEBHOOK_SUPPORTED_METRICS } from '../src/adapters/googleHealthAdapter';
import { checkProjectSubscriberHealth } from '../src/services/subscriptionHealthService';
import { runEnsureProjectSubscriber } from '../src/scripts/ensureProjectSubscriber';
import { env } from '../src/config/env';

describe('Project-Scoped Subscriber Management', () => {
  test('GoogleHealthAdapter.createOrUpdateProjectSubscriber configures AUTOMATIC subscription policy for all WEBHOOK_SUPPORTED_METRICS', async () => {
    const result = await GoogleHealthAdapter.createOrUpdateProjectSubscriber({
      projectId: 'test-project-123',
      subscriberId: 'health-dashboard-sub',
      webhookUrl: 'https://test.example.com/api/webhooks/google',
      webhookAuthToken: env.WEBHOOK_AUTH_TOKEN,
      gcpAuthToken: 'mock_gcp_token',
    });

    expect(result.active).toBe(true);
    expect(result.subscriberId).toBe('health-dashboard-sub');
    expect(result.endpointUri).toBe('https://test.example.com/api/webhooks/google');
  });

  test('WEBHOOK_SUPPORTED_METRICS matches the verified kebab-case Google Health API data types list', () => {
    const verifiedKebabCaseMetrics = [
      'active-zone-minutes',
      'activity-level',
      'altitude',
      'blood-glucose',
      'body-fat',
      'daily-heart-rate-variability',
      'daily-heart-rate-zones',
      'daily-oxygen-saturation',
      'daily-respiratory-rate',
      'daily-resting-heart-rate',
      'daily-sleep-temperature-derivations',
      'distance',
      'exercise',
      'heart-rate',
      'heart-rate-variability',
      'height',
      'hydration-log',
      'nutrition-log',
      'respiratory-rate-sleep-summary',
      'run-vo2-max',
      'sedentary-period',
      'sleep',
      'steps',
      'time-in-heart-rate-zone',
      'weight',
    ];

    expect(WEBHOOK_SUPPORTED_METRICS).toEqual(verifiedKebabCaseMetrics);
    expect(WEBHOOK_SUPPORTED_METRICS.length).toBe(25);

    // Assert strictly that zero snake_case formatting exists
    for (const metric of WEBHOOK_SUPPORTED_METRICS) {
      expect(metric).not.toContain('_');
    }
  });

  test('checkProjectSubscriberHealth returns active status for project subscriber', async () => {
    const status = await checkProjectSubscriberHealth('mock_gcp_token');
    expect(status.active).toBe(true);
    expect(status.subscriberId).toBe(env.GOOGLE_SUBSCRIBER_ID);
  });

  test('runEnsureProjectSubscriber script function executes cleanly', async () => {
    const result = await runEnsureProjectSubscriber('mock_gcp_token');
    expect(result.active).toBe(true);
  });
});
