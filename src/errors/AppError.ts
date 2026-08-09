export type ErrorContext = Record<string, unknown>;

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    context: ErrorContext = {},
    cause?: unknown,
    isOperational: boolean = true
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.context = { ...context };
    this.isOperational = isOperational;

    if (cause !== undefined && this.cause === undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }

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
  constructor(message: string, context: ErrorContext = {}, cause?: unknown, isOperational: boolean = true) {
    super(message, 400, 'VALIDATION_ERROR', context, cause, isOperational);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown, isOperational: boolean = true) {
    super(message, 401, 'AUTHENTICATION_ERROR', context, cause, isOperational);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown, isOperational: boolean = true) {
    super(message, 404, 'NOT_FOUND_ERROR', context, cause, isOperational);
  }
}

export class ExternalServiceError extends AppError {
  public readonly upstreamStatusCode?: number;
  public readonly serviceName: string;

  constructor(
    serviceName: string,
    message: string,
    upstreamStatusCode?: number,
    context: ErrorContext = {},
    cause?: unknown,
    isOperational: boolean = true
  ) {
    super(
      `External Service Error [${serviceName}]: ${message}`,
      502,
      'EXTERNAL_SERVICE_ERROR',
      {
        ...context,
        serviceName,
        upstreamStatusCode,
      },
      cause,
      isOperational
    );
    this.serviceName = serviceName;
    this.upstreamStatusCode = upstreamStatusCode;
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown, isOperational: boolean = true) {
    super(message, 500, 'DATABASE_ERROR', context, cause, isOperational);
  }
}

export class CryptographicError extends AppError {
  constructor(message: string, context: ErrorContext = {}, statusCode: number = 500, cause?: unknown, isOperational: boolean = true) {
    super(message, statusCode, 'CRYPTOGRAPHIC_ERROR', context, cause, isOperational);
  }
}
