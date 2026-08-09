import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { CryptographicError } from '../errors/AppError';

const hexStringSchema = z.string().regex(/^[0-9a-fA-F]+$/, 'Must be a valid hex string');

const encryptedPayloadSchema = z.object({
  iv: hexStringSchema,
  content: hexStringSchema,
  tag: hexStringSchema,
});

function getEncryptionKey(): Buffer {
  try {
    return Buffer.from(env.ENCRYPTION_KEY, 'hex');
  } catch (err: unknown) {
    throw new CryptographicError(
      'Failed to parse ENCRYPTION_KEY as hex buffer',
      { operation: 'getEncryptionKey' },
      500,
      err
    );
  }
}

export function encryptToken(plainText: string): string {
  if (!plainText) {
    throw new CryptographicError('Cannot encrypt empty or null token payload', {
      operation: 'encryptToken',
    });
  }

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return JSON.stringify({
      iv: iv.toString('hex'),
      content: encrypted,
      tag: authTag,
    });
  } catch (err: unknown) {
    if (err instanceof CryptographicError) throw err;
    throw new CryptographicError(
      'AES-256-GCM token encryption failed',
      { operation: 'encryptToken' },
      500,
      err
    );
  }
}

export function decryptToken(encryptedJson: string): string {
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(encryptedJson);
  } catch (err: unknown) {
    throw new CryptographicError(
      'Invalid JSON format for encrypted token payload',
      { operation: 'decryptToken' },
      500,
      err
    );
  }

  const parseResult = encryptedPayloadSchema.safeParse(parsedRaw);
  if (!parseResult.success) {
    throw new CryptographicError(
      'Encrypted payload schema validation failed',
      { operation: 'decryptToken', zodErrors: parseResult.error.errors },
      500
    );
  }

  const { iv, content, tag } = parseResult.data;

  try {
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    let decrypted = decipher.update(content, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err: unknown) {
    throw new CryptographicError(
      'AES-256-GCM token decryption or auth tag verification failed',
      { operation: 'decryptToken' },
      500,
      err
    );
  }
}

export function signState(payload: Record<string, unknown>): string {
  try {
    const key = getEncryptionKey();
    const data = JSON.stringify({
      ...payload,
      nonce: crypto.randomBytes(16).toString('hex'),
      iat: Date.now(),
    });
    const base64Data = Buffer.from(data).toString('base64url');
    const hmac = crypto.createHmac('sha256', key).update(base64Data).digest('base64url');
    return `${base64Data}.${hmac}`;
  } catch (err: unknown) {
    throw new CryptographicError(
      'OAuth state token signing failed',
      { operation: 'signState' },
      500,
      err
    );
  }
}

export function verifyState<T = Record<string, unknown>>(signedStateToken: string): T {
  if (!signedStateToken || typeof signedStateToken !== 'string') {
    throw new CryptographicError(
      'State token is missing or not a string',
      { operation: 'verifyState' },
      400
    );
  }

  const parts = signedStateToken.split('.');
  if (parts.length !== 2) {
    throw new CryptographicError(
      'Invalid state token format (expected header.signature)',
      { operation: 'verifyState' },
      400
    );
  }

  const base64Data = parts[0];
  const providedHmac = parts[1];

  if (!base64Data || !providedHmac) {
    throw new CryptographicError(
      'Invalid state token components',
      { operation: 'verifyState' },
      400
    );
  }

  let expectedHmac: string;
  try {
    const key = getEncryptionKey();
    expectedHmac = crypto.createHmac('sha256', key).update(base64Data).digest('base64url');
  } catch (err: unknown) {
    throw new CryptographicError(
      'Failed to compute state token HMAC verification signature',
      { operation: 'verifyState' },
      500,
      err
    );
  }

  const bufProvided = Buffer.from(providedHmac);
  const bufExpected = Buffer.from(expectedHmac);

  if (bufProvided.length !== bufExpected.length || !crypto.timingSafeEqual(bufProvided, bufExpected)) {
    throw new CryptographicError(
      'State token HMAC verification failed (CSRF risk)',
      { operation: 'verifyState' },
      400
    );
  }

  try {
    const jsonStr = Buffer.from(base64Data, 'base64url').toString('utf8');
    return JSON.parse(jsonStr) as T;
  } catch (err: unknown) {
    throw new CryptographicError(
      'Failed to parse decoded state payload as JSON',
      { operation: 'verifyState' },
      400,
      err
    );
  }
}
