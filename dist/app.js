"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const zod_1 = require("zod");
const authRoutes_1 = require("./routes/authRoutes");
const connectRoutes_1 = require("./routes/connectRoutes");
const AppError_1 = require("./errors/AppError");
const logger_1 = require("./utils/logger");
const env_1 = require("./config/env");
exports.app = (0, express_1.default)();
exports.app.use((0, cors_1.default)());
exports.app.use(express_1.default.json());
exports.app.use('/api/auth', authRoutes_1.authRouter);
exports.app.use('/api/connect', connectRoutes_1.connectRouter);
exports.app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Centralized Error Handling Middleware complying with Constraints #1, #2, #8
exports.app.use((err, req, res, _next) => {
    if (err instanceof AppError_1.AppError) {
        logger_1.logger.error(`Application Error [${err.code}]: ${err.message}`, {
            operation: 'ErrorHandlerMiddleware',
            path: req.path,
            method: req.method,
            statusCode: err.statusCode,
            code: err.code,
            context: err.context,
            error: err,
        });
        return res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
            context: env_1.env.NODE_ENV !== 'production' ? err.context : undefined,
        });
    }
    if (err instanceof zod_1.z.ZodError) {
        logger_1.logger.warn('Unhandled Zod validation error', {
            operation: 'ErrorHandlerMiddleware',
            path: req.path,
            method: req.method,
            zodErrors: err.errors,
        });
        return res.status(400).json({
            error: 'Invalid input parameters',
            code: 'VALIDATION_ERROR',
            details: err.errors,
        });
    }
    const unhandledError = err instanceof Error ? err : new Error(String(err));
    logger_1.logger.error('Unhandled internal server error', {
        operation: 'ErrorHandlerMiddleware',
        path: req.path,
        method: req.method,
        error: unhandledError,
    });
    return res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        details: env_1.env.NODE_ENV !== 'production' ? unhandledError.message : undefined,
    });
});
