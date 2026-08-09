export interface FetchWithTimeoutOptions extends RequestInit {
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
    serviceName?: string;
}
export declare function fetchWithTimeout(url: string, options?: FetchWithTimeoutOptions): Promise<Response>;
