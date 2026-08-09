export interface LogContext extends Record<string, unknown> {
  operation?: string;
  userId?: string;
  error?: unknown;
}

export class Logger {
  private formatMessage(level: 'info' | 'warn' | 'error', message: string, context: LogContext = {}): string {
    const errorObj = context.error as Record<string, unknown> | undefined;
    const errorDetails = context.error instanceof Error ? {
      name: context.error.name,
      message: context.error.message,
      stack: context.error.stack,
      ...(typeof errorObj === 'object' && errorObj !== null && 'context' in errorObj ? (errorObj.context as Record<string, unknown>) : {}),
    } : context.error;

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