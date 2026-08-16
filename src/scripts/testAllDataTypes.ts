import { GoogleHealthAdapter, WEBHOOK_SUPPORTED_METRICS } from '../adapters/googleHealthAdapter';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface MetricTestResult {
  metric: string;
  status: 'ACCEPTED' | 'REJECTED' | 'ERROR';
  statusCode?: number;
  errorDetails?: string;
}

export async function runSequentialDataTypeTests(customGcpToken?: string): Promise<MetricTestResult[]> {
  const gcpAuthToken = customGcpToken || process.env.GCP_AUTH_TOKEN || process.env.GOOGLE_OAUTH_TOKEN || '';
  const projectId = process.env.GOOGLE_PROJECT_NUMBER || process.env.GOOGLE_PROJECT_ID || env.GOOGLE_PROJECT_ID;
  const subscriberId = process.env.GOOGLE_SUBSCRIBER_ID || env.GOOGLE_SUBSCRIBER_ID;

  let rawBaseUrl = process.env.APP_BASE_URL || env.APP_BASE_URL;
  if ((!rawBaseUrl || rawBaseUrl.includes('localhost')) && gcpAuthToken && !gcpAuthToken.startsWith('mock_')) {
    rawBaseUrl = 'https://health-dashboard-85m6.onrender.com';
  }
  const webhookUrl = process.env.WEBHOOK_URL || `${rawBaseUrl.replace(/\/+$/, '')}/api/webhooks/google`;
  const webhookAuthToken = env.WEBHOOK_AUTH_TOKEN;

  if (!gcpAuthToken && env.NODE_ENV !== 'test') {
    logger.error('GCP_AUTH_TOKEN is required to run live data type testing.', {
      operation: 'testAllDataTypes',
      hint: 'Run with GCP_AUTH_TOKEN="ya29..." npm run test:subscriber-types',
    });
    process.exit(1);
  }

  console.log('=======================================================');
  console.log('STARTING SEQUENTIAL TESTING OF ALL 28 DATA TYPES');
  console.log('Each tested individually paired with "steps" control');
  console.log(`Project: ${projectId} | Subscriber: ${subscriberId}`);
  console.log('=======================================================\n');

  const results: MetricTestResult[] = [];

  for (let i = 0; i < WEBHOOK_SUPPORTED_METRICS.length; i++) {
    const metric = WEBHOOK_SUPPORTED_METRICS[i];
    const pair = metric === 'steps' ? ['steps', 'altitude'] : [metric, 'steps'];

    console.log(`\n-------------------------------------------------------`);
    console.log(`[${i + 1}/${WEBHOOK_SUPPORTED_METRICS.length}] TESTING METRIC: "${metric}" (Payload dataTypes: ${JSON.stringify(pair)})`);
    console.log(`-------------------------------------------------------`);

    try {
      const res = await GoogleHealthAdapter.createOrUpdateProjectSubscriber({
        projectId,
        subscriberId,
        webhookUrl,
        webhookAuthToken,
        gcpAuthToken: gcpAuthToken || 'mock_token',
        dataTypes: pair,
      });

      if (res.active) {
        console.log(`>>> RESULT: ACCEPTED (200/201 OK) for "${metric}"`);
        results.push({ metric, status: 'ACCEPTED' });
      } else {
        console.log(`>>> RESULT: REJECTED for "${metric}": ${res.error}`);
        results.push({ metric, status: 'REJECTED', errorDetails: res.error });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`>>> RESULT: ERROR for "${metric}": ${errMsg}`);
      results.push({ metric, status: 'ERROR', errorDetails: errMsg });
    }

    // Small delay between calls to be nice to rate limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n=======================================================');
  console.log('FINAL SUMMARY OF ALL 28 DATA TYPES');
  console.log('=======================================================');
  console.table(
    results.map((r) => ({
      Metric: r.metric,
      Status: r.status,
      Notes: r.status === 'ACCEPTED' ? 'Confirmed Accepted by Google API' : (r.errorDetails?.slice(0, 60) || 'Failed'),
    }))
  );

  const accepted = results.filter((r) => r.status === 'ACCEPTED');
  const rejected = results.filter((r) => r.status !== 'ACCEPTED');
  console.log(`\nTOTAL ACCEPTED: ${accepted.length} / ${WEBHOOK_SUPPORTED_METRICS.length}`);
  console.log(`TOTAL REJECTED: ${rejected.length} / ${WEBHOOK_SUPPORTED_METRICS.length}`);

  return results;
}

if (require.main === module) {
  runSequentialDataTypeTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error during sequential testing:', err);
      process.exit(1);
    });
}
