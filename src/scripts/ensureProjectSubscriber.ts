import { GoogleHealthAdapter, WEBHOOK_SUPPORTED_METRICS } from '../adapters/googleHealthAdapter';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Bisect: Test Group A2.1 (first 3 items) + confirmed clean (altitude, steps)
export const TEST_METRICS = WEBHOOK_SUPPORTED_METRICS;

/**
 * Standalone Script: Ensure Project Subscriber Exists in Google Health API
 * 
 * Usage:
 *   GCP_AUTH_TOKEN="ya29..." npm run setup:subscriber
 */
export async function runEnsureProjectSubscriber(customGcpToken?: string) {
  const gcpAuthToken = customGcpToken || process.env.GCP_AUTH_TOKEN || process.env.GOOGLE_OAUTH_TOKEN || '';
  const projectId = process.env.GOOGLE_PROJECT_NUMBER || process.env.GOOGLE_PROJECT_ID || env.GOOGLE_PROJECT_ID;
  const subscriberId = process.env.GOOGLE_SUBSCRIBER_ID || env.GOOGLE_SUBSCRIBER_ID;
  
  // Resolve data types for bisect test
  let dataTypes = TEST_METRICS;
  if (process.env.TEST_DATA_TYPES) {
    dataTypes = process.env.TEST_DATA_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Resolve public HTTPS webhook URL: prioritize WEBHOOK_URL or APP_BASE_URL env override, fallback to Render prod URL if localhost
  let rawBaseUrl = process.env.APP_BASE_URL || env.APP_BASE_URL;
  if ((!rawBaseUrl || rawBaseUrl.includes('localhost')) && gcpAuthToken && !gcpAuthToken.startsWith('mock_')) {
    rawBaseUrl = 'https://health-dashboard-85m6.onrender.com';
  }

  const webhookUrl = process.env.WEBHOOK_URL || `${rawBaseUrl.replace(/\/+$/, '')}/api/webhooks/google`;
  const webhookAuthToken = env.WEBHOOK_AUTH_TOKEN;

  if (!gcpAuthToken && env.NODE_ENV !== 'test') {
    logger.error('GCP_AUTH_TOKEN environment variable is required to authenticate with Google Cloud Health API.', {
      operation: 'ensureProjectSubscriberScript',
      hint: 'Run with GCP_AUTH_TOKEN="ya29..." npm run setup:subscriber or use Google Cloud CLI: GCP_AUTH_TOKEN=$(gcloud auth print-access-token) npm run setup:subscriber',
    });
    return { active: false, error: 'Missing GCP_AUTH_TOKEN' };
  }

  if (gcpAuthToken && !gcpAuthToken.startsWith('mock_') && !webhookUrl.startsWith('https://')) {
    logger.error('Google Health API requires a public HTTPS webhook endpoint URI (TLS 1.2+).', {
      operation: 'ensureProjectSubscriberScript',
      webhookUrl,
      hint: 'Set APP_BASE_URL="https://health-dashboard-85m6.onrender.com" or WEBHOOK_URL="https://health-dashboard-85m6.onrender.com/api/webhooks/google"',
    });
    return { active: false, error: `Invalid webhook URL protocol: ${webhookUrl} (must be HTTPS)` };
  }

  logger.info('Ensuring project-level subscriber with AUTOMATIC subscription policy (TEST Group A2.1)', {
    operation: 'ensureProjectSubscriberScript',
    projectId,
    subscriberId,
    webhookUrl,
    dataTypesCount: dataTypes.length,
    dataTypes,
  });

  const result = await GoogleHealthAdapter.createOrUpdateProjectSubscriber({
    projectId,
    subscriberId,
    webhookUrl,
    webhookAuthToken,
    gcpAuthToken: gcpAuthToken || 'mock_token',
    dataTypes,
  });

  if (result.active) {
    logger.info('Project-level subscriber verified and active!', {
      operation: 'ensureProjectSubscriberScript',
      subscriberId: result.subscriberId,
      endpointUri: result.endpointUri,
    });
  } else {
    logger.error('Failed to configure project-level subscriber in Google Health API', {
      operation: 'ensureProjectSubscriberScript',
      error: result.error,
    });
  }

  return result;
}

if (require.main === module) {
  runEnsureProjectSubscriber()
    .then((res) => {
      if (res.active) {
        process.exit(0);
      } else {
        logger.error('ensureProjectSubscriber execution finished with error status', {
          operation: 'ensureProjectSubscriberCli',
          error: res.error,
        });
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      logger.error('Fatal unhandled error during ensureProjectSubscriber execution', {
        operation: 'ensureProjectSubscriberCli:fatal',
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
