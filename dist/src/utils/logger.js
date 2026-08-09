"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
class Logger {
    formatMessage(level, message, context = {}) {
        const errorObj = context.error;
        const errorDetails = context.error instanceof Error ? {
            name: context.error.name,
            message: context.error.message,
            stack: context.error.stack,
            ...(typeof errorObj === 'object' && errorObj !== null && 'context' in errorObj ? errorObj.context : {}),
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
    info(message, context) {
        console.log(this.formatMessage('info', message, context));
    }
    warn(message, context) {
        console.warn(this.formatMessage('warn', message, context));
    }
    error(message, context) {
        console.error(this.formatMessage('error', message, context));
    }
}
exports.Logger = Logger;
exports.logger = new Logger();
