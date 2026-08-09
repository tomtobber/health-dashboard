"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const app_1 = require("../src/app");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../src/config/env");
describe('Connect Routes API (Google OAuth)', () => {
    let authToken;
    const mockUser = { id: 'test-user-id-123', email: 'test@example.com' };
    beforeAll(() => {
        authToken = jsonwebtoken_1.default.sign(mockUser, env_1.env.JWT_SECRET, { expiresIn: '1h' });
    });
    test('GET /api/connect/google/authorize generates signed state and required scopes', async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .get('/api/connect/google/authorize')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('authUrl');
        expect(res.body).toHaveProperty('signedState');
        expect(res.body.authUrl).toContain('accounts.google.com');
        expect(res.body.authUrl).toContain('activity_and_fitness');
        expect(res.body.authUrl).toContain('health_metrics_and_measurements');
        expect(res.body.requestedScopes).toContain('activity_and_fitness');
        expect(res.body.requestedScopes).toContain('health_metrics_and_measurements');
    });
    test('GET /api/connect/google/callback fails with 500 CryptographicError on tampered state parameter', async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .get('/api/connect/google/callback?code=mock_code&state=invalid_state');
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('CRYPTOGRAPHIC_ERROR');
        expect(res.body.error).toMatch(/state token/i);
    });
    test('GET /api/connect/google/callback succeeds with valid code and signed state', async () => {
        const authRes = await (0, supertest_1.default)(app_1.app)
            .get('/api/connect/google/authorize')
            .set('Authorization', `Bearer ${authToken}`);
        const signedState = authRes.body.signedState;
        const callbackRes = await (0, supertest_1.default)(app_1.app)
            .get(`/api/connect/google/callback?code=test_oauth_code_999&state=${encodeURIComponent(signedState)}`);
        expect(callbackRes.status).toBe(200);
        expect(callbackRes.body.message).toContain('successfully connected');
        expect(callbackRes.body.provider).toBe('google_health');
        expect(callbackRes.body.scopes).toContain('activity_and_fitness');
        expect(callbackRes.body.scopes).toContain('health_metrics_and_measurements');
    });
});
