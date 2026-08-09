export type ErrorContext = Record<string, unknown>;
export declare class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly context: ErrorContext;
    constructor(message: string, statusCode?: number, code?: string, context?: ErrorContext);
}
export declare class ValidationError extends AppError {
    constructor(message: string, context?: ErrorContext);
}
export declare class AuthenticationError extends AppError {
    constructor(message: string, context?: ErrorContext);
}
export declare class NotFoundError extends AppError {
    constructor(message: string, context?: ErrorContext);
}
export declare class ExternalServiceError extends AppError {
    readonly upstreamStatusCode?: number;
    readonly serviceName: string;
    constructor(serviceName: string, message: string, upstreamStatusCode?: number, context?: ErrorContext);
}
export declare class DatabaseError extends AppError {
    constructor(message: string, context?: ErrorContext);
}
export declare class CryptographicError extends AppError {
    constructor(message: string, context?: ErrorContext);
}
