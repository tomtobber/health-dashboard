export type ErrorContext = Record<string, unknown>;

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly context: ErrorContext;

  constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR', context: ErrorContext = {}) {
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

export class ValidationError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 400, 'VALIDATION_ERROR', context);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 401, 'AUTHENTICATION_ERROR', context);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 404, 'NOT_FOUND_ERROR', context);
  }
}

export class ExternalServiceError extends AppError {
  public readonly upstreamStatusCode?: number;
  public readonly serviceName: string;

  constructor(serviceName: string, message: string, upstreamStatusCode?: number, context: ErrorContext = {}) {
    super(`External Service Error [${serviceName}]: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', {
      ...context,
      serviceName,
      upstreamStatusCode,
    });
    this.serviceName = serviceName;
    this.upstreamStatusCode = upstreamStatusCode;
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 500, 'DATABASE_ERROR', context);
  }
}

export class CryptographicError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 500, 'CRYPTOGRAPHIC_ERROR', context);
  }
}