"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchWithTimeout = fetchWithTimeout;
const AppError_1 = require("../errors/AppError");
const logger_1 = require("./logger");
async function fetchWithTimeout(url, options = {}) {
    const { timeoutMs = 8000, retries = 2, backoffMs = 500, serviceName = 'ExternalAPI', ...fetchOptions } = options;
    let attempt = 0;
    while (attempt <= retries) {
        attempt++;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            // Do not retry on 4xx client errors (validation / auth)
            if (response.status >= 400 && response.status < 500) {
                return response;
            }
            // Retry on 5xx transient server errors
            if (response.status >= 500 && attempt <= retries) {
                logger_1.logger.warn('Transient server error from external service, retrying', {
                    operation: 'fetchWithTimeout',
                    serviceName,
                    url,
                    attempt,
                    status: response.status,
                });
                await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
                continue;
            }
            return response;
        }
        catch (err) {
            clearTimeout(timeoutId);
            const isAbort = err instanceof Error && err.name === 'AbortError';
            const errorMessage = isAbort ? `Request timed out after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err));
            if (attempt <= retries && !isAbort) {
                logger_1.logger.warn('Network error fetching from external service, retrying', {
                    operation: 'fetchWithTimeout',
                    serviceName,
                    url,
                    attempt,
                    error: errorMessage,
                });
                await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
                continue;
            }
            throw new AppError_1.ExternalServiceError(serviceName, errorMessage, undefined, {
                url,
                attempt,
                timeoutMs,
                originalError: errorMessage,
            });
        }
    }
    throw new AppError_1.ExternalServiceError(serviceName, 'Max retries exceeded', undefined, {
        url,
        retries,
    });
}
