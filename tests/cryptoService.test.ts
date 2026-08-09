import { encryptToken, decryptToken, signState, verifyState } from '../src/services/cryptoService';
import { CryptographicError } from '../src/errors/AppError';

describe('cryptoService', () => {
  test('encrypts and decrypts OAuth token correctly', () => {
    const plainToken = 'ya29.a0Axoo-mock-google-oauth-access-token-123456';
    const encrypted = encryptToken(plainToken);

    expect(encrypted).not.toEqual(plainToken);
    expect(JSON.parse(encrypted)).toHaveProperty('iv');
    expect(JSON.parse(encrypted)).toHaveProperty('content');
    expect(JSON.parse(encrypted)).toHaveProperty('tag');

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toEqual(plainToken);
  });

  test('throws CryptographicError if encrypted payload authTag is tampered with', () => {
    const plainToken = 'secret-refresh-token';
    const encrypted = encryptToken(plainToken);
    const parsed = JSON.parse(encrypted);
    parsed.tag = '00000000000000000000000000000000';

    expect(() => decryptToken(JSON.stringify(parsed))).toThrow(CryptographicError);
  });

  test('signs and verifies state token with HMAC-SHA256', () => {
    const payload = { userId: 'user-uuid-123' };
    const signedToken = signState(payload);

    expect(typeof signedToken).toBe('string');
    expect(signedToken.split('.').length).toBe(2);

    const verifiedPayload = verifyState<{ userId: string }>(signedToken);
    expect(verifiedPayload.userId).toBe('user-uuid-123');
  });

  test('rejects tampered state token during verification (CSRF protection)', () => {
    const payload = { userId: 'user-uuid-123' };
    const signedToken = signState(payload);
    const [base64Data] = signedToken.split('.');
    const tamperedToken = `${base64Data}.invalid_hmac_signature`;

    expect(() => verifyState(tamperedToken)).toThrow(CryptographicError);
  });
});