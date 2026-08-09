"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cryptoService_1 = require("../src/services/cryptoService");
const AppError_1 = require("../src/errors/AppError");
describe('cryptoService', () => {
    test('encrypts and decrypts OAuth token correctly', () => {
        const plainToken = 'ya29.a0Axoo-mock-google-oauth-access-token-123456';
        const encrypted = (0, cryptoService_1.encryptToken)(plainToken);
        expect(encrypted).not.toEqual(plainToken);
        expect(JSON.parse(encrypted)).toHaveProperty('iv');
        expect(JSON.parse(encrypted)).toHaveProperty('content');
        expect(JSON.parse(encrypted)).toHaveProperty('tag');
        const decrypted = (0, cryptoService_1.decryptToken)(encrypted);
        expect(decrypted).toEqual(plainToken);
    });
    test('throws CryptographicError if encrypted payload authTag is tampered with', () => {
        const plainToken = 'secret-refresh-token';
        const encrypted = (0, cryptoService_1.encryptToken)(plainToken);
        const parsed = JSON.parse(encrypted);
        parsed.tag = '00000000000000000000000000000000';
        expect(() => (0, cryptoService_1.decryptToken)(JSON.stringify(parsed))).toThrow(AppError_1.CryptographicError);
    });
    test('signs and verifies state token with HMAC-SHA256', () => {
        const payload = { userId: 'user-uuid-123' };
        const signedToken = (0, cryptoService_1.signState)(payload);
        expect(typeof signedToken).toBe('string');
        expect(signedToken.split('.').length).toBe(2);
        const verifiedPayload = (0, cryptoService_1.verifyState)(signedToken);
        expect(verifiedPayload.userId).toBe('user-uuid-123');
    });
    test('rejects tampered state token during verification (CSRF protection)', () => {
        const payload = { userId: 'user-uuid-123' };
        const signedToken = (0, cryptoService_1.signState)(payload);
        const [base64Data] = signedToken.split('.');
        const tamperedToken = `${base64Data}.invalid_hmac_signature`;
        expect(() => (0, cryptoService_1.verifyState)(tamperedToken)).toThrow(AppError_1.CryptographicError);
    });
});
