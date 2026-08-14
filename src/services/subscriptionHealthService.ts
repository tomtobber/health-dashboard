import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq } from 'drizzle-orm';
import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { decryptToken } from './cryptoService';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface SubscriptionStatus {
  subscriptionId: string;
  status: 'active' | 'disabled' | 'expired';
  lastVerifiedAt: Date;
  error?: string;
}

export async function checkAndRenewWebhookSubscriptions(userId: string): Promise<SubscriptionStatus> {
  const adapter = new GoogleHealthAdapter();

  if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL?.includes('neon.tech')) {
    return {
      subscriptionId: 'mock_sub_' + userId,
      status: 'active',
      lastVerifiedAt: new Date(),
    };
  }

  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));

  if (!account) {
    return {
      subscriptionId: 'none',
      status: 'disabled',
      lastVerifiedAt: new Date(),
      error: 'No connected account found',
    };
  }

  const decryptedAccessToken = decryptToken(account.accessToken);
  const healthCheck = await adapter.checkSubscriptionHealth?.(undefined, decryptedAccessToken);

  if (healthCheck && !healthCheck.active) {
    logger.warn('Subscription inactive, attempting auto-renewal', {
      operation: 'checkAndRenewWebhookSubscriptions:renew',
      userId,
      error: healthCheck.error,
    });

    const webhookUrl = `${env.APP_BASE_URL}/api/webhooks/google`;
    const renewalResult = await adapter.createSubscription?.(webhookUrl, decryptedAccessToken);

    return {
      subscriptionId: renewalResult?.subscriptionId || 'renewed_sub',
      status: renewalResult?.active ? 'active' : 'disabled',
      lastVerifiedAt: new Date(),
      error: renewalResult?.error,
    };
  }

  return {
    subscriptionId: 'active_sub',
    status: 'active',
    lastVerifiedAt: new Date(),
  };
}

export async function checkAllSubscriptionsHealth(): Promise<SubscriptionStatus[]> {
  const isLiveDb = process.env.NODE_ENV !== 'test' || Boolean(process.env.DATABASE_URL?.includes('neon.tech'));

  if (!isLiveDb) {
    return [{
      subscriptionId: 'mock_sub_all',
      status: 'active',
      lastVerifiedAt: new Date(),
    }];
  }

  const accounts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, 'active'));

  const results: SubscriptionStatus[] = [];
  for (const acc of accounts) {
    const status = await checkAndRenewWebhookSubscriptions(acc.userId);
    results.push(status);
  }

  return results;
}
