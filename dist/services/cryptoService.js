"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptToken = encryptToken;
exports.decryptToken = decryptToken;
exports.signState = signState;
exports.verifyState = verifyState;
const crypto_1 = __importDefault(require("crypto"));
const zod_1 = require("zod");
const env_1 = require("../config/env");
const AppError_1 = require("../errors/AppError");
const hexStringSchema = zod_1.z.string().regex(/^[0-9a-fA-F]+$/, 'Must be a valid hex string');
const encryptedPayloadSchema = zod_1.z.object({
    iv: hexStringSchema,
    content: hexStringSchema,
    tag: hexStringSchema,
});
function getEncryptionKey() {
    try {
        return Buffer.from(env_1.env.ENCRYPTION_KEY, 'hex');
    }
    catch (err) {
        throw new AppError_1.CryptographicError('Failed to parse ENCRYPTION_KEY as hex buffer', {
            operation: 'getEncryptionKey',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
}
function encryptToken(plainText) {
    if (!plainText) {
        throw new AppError_1.CryptographicError('Cannot encrypt empty or null token payload', {
            operation: 'encryptToken',
        });
    }
    try {
        const key = getEncryptionKey();
        const iv = crypto_1.default.randomBytes(12);
        const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(plainText, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return JSON.stringify({
            iv: iv.toString('hex'),
            content: encrypted,
            tag: authTag,
        });
    }
    catch (err) {
        if (err instanceof AppError_1.CryptographicError)
            throw err;
        throw new AppError_1.CryptographicError('AES-256-GCM token encryption failed', {
            operation: 'encryptToken',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
}
function decryptToken(encryptedJson) {
    let parsedRaw;
    try {
        parsedRaw = JSON.parse(encryptedJson);
    }
    catch (err) {
        throw new AppError_1.CryptographicError('Invalid JSON format for encrypted token payload', {
            operation: 'decryptToken',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
    const parseResult = encryptedPayloadSchema.safeParse(parsedRaw);
    if (!parseResult.success) {
        throw new AppError_1.CryptographicError('Encrypted payload schema validation failed', {
            operation: 'decryptToken',
            zodErrors: parseResult.error.errors,
        });
    }
    const { iv, content, tag } = parseResult.data;
    try {
        const key = getEncryptionKey();
        const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(tag, 'hex'));
        let decrypted = decipher.update(content, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    catch (err) {
        throw new AppError_1.CryptographicError('AES-256-GCM token decryption or auth tag verification failed', {
            operation: 'decryptToken',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
}
function signState(payload) {
    try {
        const key = getEncryptionKey();
        const data = JSON.stringify({
            ...payload,
            nonce: crypto_1.default.randomBytes(16).toString('hex'),
            iat: Date.now(),
        });
        const base64Data = Buffer.from(data).toString('base64url');
        const hmac = crypto_1.default.createHmac('sha256', key).update(base64Data).digest('base64url');
        return `${base64Data}.${hmac}`;
    }
    catch (err) {
        throw new AppError_1.CryptographicError('OAuth state token signing failed', {
            operation: 'signState',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
}
function verifyState(signedStateToken) {
    if (!signedStateToken || typeof signedStateToken !== 'string') {
        throw new AppError_1.CryptographicError('State token is missing or not a string', {
            operation: 'verifyState',
        });
    }
    const parts = signedStateToken.split('.');
    if (parts.length !== 2) {
        throw new AppError_1.CryptographicError('Invalid state token format (expected header.signature)', {
            operation: 'verifyState',
        });
    }
    const base64Data = parts[0];
    const providedHmac = parts[1];
    if (!base64Data || !providedHmac) {
        throw new AppError_1.CryptographicError('Invalid state token components', {
            operation: 'verifyState',
        });
    }
    let expectedHmac;
    try {
        const key = getEncryptionKey();
        expectedHmac = crypto_1.default.createHmac('sha256', key).update(base64Data).digest('base64url');
    }
    catch (err) {
        throw new AppError_1.CryptographicError('Failed to compute state token HMAC verification signature', {
            operation: 'verifyState',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
    const bufProvided = Buffer.from(providedHmac);
    const bufExpected = Buffer.from(expectedHmac);
    if (bufProvided.length !== bufExpected.length || !crypto_1.default.timingSafeEqual(bufProvided, bufExpected)) {
        throw new AppError_1.CryptographicError('State token HMAC verification failed (CSRF risk)', {
            operation: 'verifyState',
        });
    }
    try {
        const jsonStr = Buffer.from(base64Data, 'base64url').toString('utf8');
        return JSON.parse(jsonStr);
    }
    catch (err) {
        throw new AppError_1.CryptographicError('Failed to parse decoded state payload as JSON', {
            operation: 'verifyState',
            cause: err instanceof Error ? err.message : String(err),
        });
    }
}
