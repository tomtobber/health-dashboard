export interface LogContext extends Record<string, unknown> {
    operation?: string;
    userId?: string;
    error?: unknown;
}
export declare class Logger {
    private formatMessage;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
}
export declare const logger: Logger;
