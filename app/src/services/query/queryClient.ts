import {
  QueryClient,
  QueryClientConfig,
} from '@tanstack/react-query';

/**
 * Default cache policies for TanStack Query.
 */
export const DEFAULT_STALE_TIME_MS = 2 * 60 * 1000; // 2 minutes: fresh window prevents refetch storm
export const DEFAULT_GC_TIME_MS = 10 * 60 * 1000; // 10 minutes: garbage-collection retention for inactive queries
export const MAX_RETRY_COUNT = 2; // Up to 2 retries (total 3 attempts)
export const BASE_RETRY_DELAY_MS = 1000; // 1 second initial backoff
export const MAX_RETRY_DELAY_MS = 30000; // 30 seconds max delay

/**
 * Calculates exponential retry backoff:
 * attempt 0 -> 1000ms
 * attempt 1 -> 2000ms
 * attempt 2 -> 4000ms, etc., capped at maxDelayMs.
 */
export function calculateRetryBackoff(
  attemptIndex: number,
  baseDelayMs = BASE_RETRY_DELAY_MS,
  maxDelayMs = MAX_RETRY_DELAY_MS
): number {
  return Math.min(baseDelayMs * 2 ** attemptIndex, maxDelayMs);
}

/**
 * Determines whether a failed query should be retried.
 * Failures with HTTP 401 (Unauthorized), 403 (Forbidden), or 404 (Not Found)
 * are definitive client errors and MUST NOT be retried.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRY_COUNT) {
    return false;
  }

  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
      return false;
    }
  }

  return true;
}

/**
 * Factory function creating a configured QueryClient.
 */
export function createQueryClient(customConfig?: QueryClientConfig): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        gcTime: DEFAULT_GC_TIME_MS,
        retry: shouldRetryQuery,
        retryDelay: (attemptIndex) => calculateRetryBackoff(attemptIndex),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        ...customConfig?.defaultOptions?.queries,
      },
      mutations: {
        retry: false,
        ...customConfig?.defaultOptions?.mutations,
      },
    },
    ...customConfig,
  });
}

/**
 * Application-wide singleton QueryClient instance.
 */
export const queryClient = createQueryClient();

/**
 * Clears all cached queries and cancels active queries.
 * Must be executed upon sign-out, session expiration, or account switching.
 */
export async function clearQueryCache(client: QueryClient = queryClient): Promise<void> {
  await client.cancelQueries();
  client.clear();
}
