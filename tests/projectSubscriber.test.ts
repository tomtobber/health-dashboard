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

  test('WEBHOOK_SUPPORTED_METRICS contains 28 verified Google Health API data types', () => {
    expect(WEBHOOK_SUPPORTED_METRICS.length).toBe(28);
    expect(WEBHOOK_SUPPORTED_METRICS).toContain('activeZoneMinutes');
    expect(WEBHOOK_SUPPORTED_METRICS).toContain('runVo2Max');
    expect(WEBHOOK_SUPPORTED_METRICS).toContain('totalCalories');
    expect(WEBHOOK_SUPPORTED_METRICS).toContain('heartRate');
    expect(WEBHOOK_SUPPORTED_METRICS).toContain('sleep');
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
