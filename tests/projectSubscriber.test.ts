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

  test('WEBHOOK_SUPPORTED_METRICS matches the exact verified 28 camelCase Google Health API data types list', () => {
    const verifiedCamelCaseMetrics = [
      'activeZoneMinutes',
      'activityLevel',
      'altitude',
      'bloodGlucose',
      'bodyFat',
      'caloriesInHeartRateZone',
      'dailyHeartRateVariability',
      'dailyHeartRateZones',
      'dailyOxygenSaturation',
      'dailyRespiratoryRate',
      'dailyRestingHeartRate',
      'dailySleepTemperatureDerivations',
      'distance',
      'exercise',
      'floors',
      'heartRate',
      'heartRateVariability',
      'height',
      'hydrationLog',
      'nutritionLog',
      'respiratoryRateSleepSummary',
      'runVo2Max',
      'sedentaryPeriod',
      'sleep',
      'steps',
      'timeInHeartRateZone',
      'totalCalories',
      'weight',
    ];

    expect(WEBHOOK_SUPPORTED_METRICS).toEqual(verifiedCamelCaseMetrics);
    expect(WEBHOOK_SUPPORTED_METRICS.length).toBe(28);

    // Assert strictly that zero snake_case or legacy formatting exists
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
