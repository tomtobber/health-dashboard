import { ExternalServiceError } from '../errors/AppError';
import { logger } from './logger';

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  serviceName?: string;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 8000,
    retries = 2,
    backoffMs = 500,
    serviceName = 'ExternalAPI',
    ...fetchOptions
  } = options;

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

      // Handle 5xx transient server errors
      if (response.status >= 500) {
        if (attempt <= retries) {
          logger.warn('Transient server error from external service, retrying', {
            operation: 'fetchWithTimeout',
            serviceName,
            url,
            attempt,
            status: response.status,
          });
          await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
          continue;
        }

        throw new ExternalServiceError(
          serviceName,
          `HTTP ${response.status} server error from ${serviceName} after ${retries} retries`,
          response.status,
          {
            url,
            attempt,
            status: response.status,
            retries,
          }
        );
      }

      return response;
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof ExternalServiceError) {
        throw err;
      }

      const isAbort = err instanceof Error && err.name === 'AbortError';
      const errorMessage = isAbort ? `Request timed out after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err));

      if (attempt <= retries && !isAbort) {
        logger.warn('Network error fetching from external service, retrying', {
          operation: 'fetchWithTimeout',
          serviceName,
          url,
          attempt,
          error: errorMessage,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
        continue;
      }

      throw new ExternalServiceError(serviceName, errorMessage, undefined, {
        url,
        attempt,
        timeoutMs,
        originalError: errorMessage,
      });
    }
  }

  throw new ExternalServiceError(serviceName, 'Max retries exceeded', undefined, {
    url,
    retries,
  });
}
