export interface LogContext extends Record<string, unknown> {
  operation?: string;
  userId?: string;
  error?: unknown;
}

export function serializeError(err: unknown): Record<string, unknown> | unknown {
  if (!(err instanceof Error)) {
    if (typeof err === 'object' && err !== null) {
      return { ...(err as Record<string, unknown>) };
    }
    return err;
  }

  const errRecord = err as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };

  if ('code' in errRecord && errRecord.code !== undefined) {
    result.code = errRecord.code;
  }
  if ('statusCode' in errRecord && errRecord.statusCode !== undefined) {
    result.statusCode = errRecord.statusCode;
  }
  if ('context' in errRecord && typeof errRecord.context === 'object' && errRecord.context !== null) {
    result.context = errRecord.context;
  }
  if (err.cause !== undefined) {
    result.cause = serializeError(err.cause);
  }

  return result;
}

export class Logger {
  private formatMessage(level: 'info' | 'warn' | 'error', message: string, context: LogContext = {}): string {
    const errorDetails = context.error !== undefined ? serializeError(context.error) : undefined;

    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      operation: context.operation || 'application',
      userId: context.userId,
      ...context,
      error: errorDetails,
    });
  }

  public info(message: string, context?: LogContext): void {
    console.log(this.formatMessage('info', message, context));
  }

  public warn(message: string, context?: LogContext): void {
    console.warn(this.formatMessage('warn', message, context));
  }

  public error(message: string, context?: LogContext): void {
    console.error(this.formatMessage('error', message, context));
  }
}

export const logger = new Logger();
