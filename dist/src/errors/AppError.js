"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CryptographicError = exports.DatabaseError = exports.ExternalServiceError = exports.NotFoundError = exports.AuthenticationError = exports.ValidationError = exports.AppError = void 0;
class AppError extends Error {
    statusCode;
    code;
    context;
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', context = {}) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.context = context;
        Object.defineProperty(this, 'message', {
            value: message,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(this, 'name', {
            value: this.constructor.name,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
class ValidationError extends AppError {
    constructor(message, context = {}) {
        super(message, 400, 'VALIDATION_ERROR', context);
    }
}
exports.ValidationError = ValidationError;
class AuthenticationError extends AppError {
    constructor(message, context = {}) {
        super(message, 401, 'AUTHENTICATION_ERROR', context);
    }
}
exports.AuthenticationError = AuthenticationError;
class NotFoundError extends AppError {
    constructor(message, context = {}) {
        super(message, 404, 'NOT_FOUND_ERROR', context);
    }
}
exports.NotFoundError = NotFoundError;
class ExternalServiceError extends AppError {
    upstreamStatusCode;
    serviceName;
    constructor(serviceName, message, upstreamStatusCode, context = {}) {
        super(`External Service Error [${serviceName}]: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', {
            ...context,
            serviceName,
            upstreamStatusCode,
        });
        this.serviceName = serviceName;
        this.upstreamStatusCode = upstreamStatusCode;
    }
}
exports.ExternalServiceError = ExternalServiceError;
class DatabaseError extends AppError {
    constructor(message, context = {}) {
        super(message, 500, 'DATABASE_ERROR', context);
    }
}
exports.DatabaseError = DatabaseError;
class CryptographicError extends AppError {
    constructor(message, context = {}) {
        super(message, 500, 'CRYPTOGRAPHIC_ERROR', context);
    }
}
exports.CryptographicError = CryptographicError;
