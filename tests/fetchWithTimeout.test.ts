import { fetchWithTimeout } from '../src/utils/fetchWithTimeout';
import { ExternalServiceError } from '../src/errors/AppError';

describe('fetchWithTimeout Utility', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test('a. TIMEOUT: Aborts request and rejects with ExternalServiceError when request exceeds timeoutMs', async () => {
    jest.useFakeTimers();

    global.fetch = jest.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const promise = fetchWithTimeout('https://api.example.com/slow', {
      timeoutMs: 1000,
      retries: 0,
    });

    const rejectionExpectation = expect(promise).rejects.toThrow('Request timed out after 1000ms');

    jest.advanceTimersByTime(1001);

    await rejectionExpectation;
  });

  test('b. RETRY ON TRANSIENT FAILURE: Retries on 5xx status up to max retries count', async () => {
    jest.useFakeTimers();

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('Internal Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    global.fetch = mockFetch;

    const promise = fetchWithTimeout('https://api.example.com/data', {
      retries: 2,
      backoffMs: 100,
    });

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('c. BACKOFF: Exponentially increases delay between retries using fake timers', async () => {
    jest.useFakeTimers();

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('Error 1', { status: 502 }))
      .mockResolvedValueOnce(new Response('Error 2', { status: 502 }))
      .mockResolvedValueOnce(new Response('Success', { status: 200 }));

    global.fetch = mockFetch;

    const promise = fetchWithTimeout('https://api.example.com/backoff', {
      retries: 2,
      backoffMs: 500,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(499);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const res = await promise;
    expect(res.status).toBe(200);
  });

  test('d. NO RETRY ON 4xx: Does NOT retry client 4xx errors (400, 401, 404)', async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    global.fetch = mockFetch;

    const res = await fetchWithTimeout('https://api.example.com/protected', {
      retries: 3,
    });

    expect(res.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('e. SUCCESS PATH: Returns response immediately on 1st successful attempt with no extra retries', async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));
    global.fetch = mockFetch;

    const res = await fetchWithTimeout('https://api.example.com/success', {
      retries: 3,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual({ data: 'ok' });
  });

  test('f. EXHAUSTED RETRIES ON NETWORK ERROR: Rejects with ExternalServiceError when network error persists', async () => {
    jest.useFakeTimers();

    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    global.fetch = mockFetch;

    const promise = fetchWithTimeout('https://api.example.com/network-fail', {
      serviceName: 'TestService',
      retries: 2,
      backoffMs: 100,
    });

    const rejectionExpectation = expect(promise).rejects.toThrow(ExternalServiceError);

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    await rejectionExpectation;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('g. EXHAUSTED RETRIES ON 5xx: Rejects with ExternalServiceError when 5xx persists through all retries', async () => {
    jest.useFakeTimers();

    const mockFetch = jest.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    global.fetch = mockFetch;

    const promise = fetchWithTimeout('https://api.example.com/persistent-500', {
      serviceName: 'UpstreamService',
      retries: 2,
      backoffMs: 100,
    });

    const rejectionExpectation = expect(promise).rejects.toThrow(ExternalServiceError);

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    await rejectionExpectation;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
