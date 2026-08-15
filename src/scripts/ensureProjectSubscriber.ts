import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Standalone Script: Ensure Project Subscriber Exists in Google Health API
 * 
 * Usage:
 *   GCP_AUTH_TOKEN="ya29..." npm run setup:subscriber
 * 
 * Or with custom project ID:
 *   GCP_AUTH_TOKEN="ya29..." GOOGLE_PROJECT_ID="your-project-id" npm run setup:subscriber
 */
export async function runEnsureProjectSubscriber(customGcpToken?: string) {
  const gcpAuthToken = customGcpToken || process.env.GCP_AUTH_TOKEN || process.env.GOOGLE_OAUTH_TOKEN || '';
  const projectId = process.env.GOOGLE_PROJECT_ID || env.GOOGLE_PROJECT_ID;
  const subscriberId = process.env.GOOGLE_SUBSCRIBER_ID || env.GOOGLE_SUBSCRIBER_ID;
  const webhookUrl = `${env.APP_BASE_URL}/api/webhooks/google`;
  const webhookAuthToken = env.WEBHOOK_AUTH_TOKEN;

  if (!gcpAuthToken && env.NODE_ENV !== 'test') {
    logger.error('GCP_AUTH_TOKEN environment variable is required to authenticate with Google Cloud Health API.', {
      operation: 'ensureProjectSubscriberScript',
      hint: 'Run with GCP_AUTH_TOKEN="ya29..." npm run setup:subscriber or use Google Cloud CLI: GCP_AUTH_TOKEN=$(gcloud auth print-access-token) npm run setup:subscriber',
    });
    return { active: false, error: 'Missing GCP_AUTH_TOKEN' };
  }

  logger.info('Ensuring project-level subscriber with AUTOMATIC subscription policy', {
    operation: 'ensureProjectSubscriberScript',
    projectId,
    subscriberId,
    webhookUrl,
  });

  const result = await GoogleHealthAdapter.createOrUpdateProjectSubscriber({
    projectId,
    subscriberId,
    webhookUrl,
    webhookAuthToken,
    gcpAuthToken: gcpAuthToken || 'mock_token',
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
  void runEnsureProjectSubscriber().then((res) => {
    if (res.active) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  });
}
