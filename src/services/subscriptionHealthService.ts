import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ProjectSubscriberStatus {
  subscriberId: string;
  active: boolean;
  endpointUri?: string;
  lastCheckedAt: Date;
  error?: string;
}

/**
 * Checks or verifies the project-level Google Health subscriber.
 */
export async function checkProjectSubscriberHealth(gcpAuthToken?: string): Promise<ProjectSubscriberStatus> {
  const isTest = env.NODE_ENV === 'test' || !gcpAuthToken || gcpAuthToken.startsWith('mock_');

  if (isTest) {
    return {
      subscriberId: env.GOOGLE_SUBSCRIBER_ID,
      active: true,
      endpointUri: `${env.APP_BASE_URL}/api/webhooks/google`,
      lastCheckedAt: new Date(),
    };
  }

  logger.info('Verifying project subscriber health in Google Health API', {
    operation: 'checkProjectSubscriberHealth',
    projectId: env.GOOGLE_PROJECT_ID,
    subscriberId: env.GOOGLE_SUBSCRIBER_ID,
  });

  const result = await GoogleHealthAdapter.createOrUpdateProjectSubscriber({
    projectId: env.GOOGLE_PROJECT_ID,
    subscriberId: env.GOOGLE_SUBSCRIBER_ID,
    webhookUrl: `${env.APP_BASE_URL}/api/webhooks/google`,
    webhookAuthToken: env.WEBHOOK_AUTH_TOKEN,
    gcpAuthToken,
  });

  return {
    subscriberId: result.subscriberId,
    active: result.active,
    endpointUri: result.endpointUri,
    lastCheckedAt: new Date(),
    error: result.error,
  };
}
