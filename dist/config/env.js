"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = exports.envSchema = void 0;
const zod_1 = require("zod");
const dotenv = __importStar(require("dotenv"));
const AppError_1 = require("../errors/AppError");
dotenv.config();
exports.envSchema = zod_1.z.object({
    PORT: zod_1.z.string().default('3000'),
    DATABASE_URL: zod_1.z.string().default('postgresql://postgres:postgres@localhost:5432/health_dashboard'),
    JWT_SECRET: zod_1.z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
    ENCRYPTION_KEY: zod_1.z.string().length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),
    GOOGLE_CLIENT_ID: zod_1.z.string().default('mock-google-client-id'),
    GOOGLE_CLIENT_SECRET: zod_1.z.string().default('mock-google-client-secret'),
    GOOGLE_REDIRECT_URI: zod_1.z.string().default('http://localhost:3000/api/connect/google/callback'),
    APP_BASE_URL: zod_1.z.string().default('http://localhost:3000'),
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
});
function loadEnv() {
    const result = exports.envSchema.safeParse(process.env);
    if (!result.success) {
        const errorDetails = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new AppError_1.ValidationError(`Environment variable validation failed: ${errorDetails}`, {
            zodErrors: result.error.errors,
        });
    }
    return result.data;
}
exports.env = loadEnv();
