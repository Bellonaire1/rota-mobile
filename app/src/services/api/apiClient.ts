import { API_BASE_URL } from '@/constants/config';
import { ApiErrorResponse } from '@/types/api';

export interface ApiRequestOptions extends RequestInit {
  allowRefresh?: boolean;
  skipAuth?: boolean;
}

type RefreshHandler = () => Promise<string | null>;

export class ApiError extends Error {
  public statusCode: number;
  public details?: ApiErrorResponse;

  constructor(message: string, statusCode: number, details?: ApiErrorResponse) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Base HTTP client configured with baseUrl and JSON headers.
 */
export class ApiClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private refreshHandler: RefreshHandler | null = null;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  public setAccessToken(accessToken: string | null): void {
    this.accessToken = accessToken;
  }

  public setRefreshHandler(handler: RefreshHandler | null): void {
    this.refreshHandler = handler;
  }

  private async request<T>(endpoint: string, options: ApiRequestOptions = {}): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const { allowRefresh = true, skipAuth = false, ...fetchOptions } = options;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.accessToken && !skipAuth
        ? { Authorization: `Bearer ${this.accessToken}` }
        : {}),
      ...fetchOptions.headers,
    };

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 401 && allowRefresh && !skipAuth && this.refreshHandler) {
          const accessToken = await this.refreshHandler();
          if (accessToken) {
            return this.request<T>(endpoint, {
              ...options,
              allowRefresh: false,
            });
          }
        }

        const errorMessage = data?.message || `Request failed with status ${response.status}`;
        throw new ApiError(errorMessage, response.status, data);
      }

      return data as T;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError((error as Error).message || 'Network request failed', 0);
    }
  }

  public get<T>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  public post<T>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  public put<T>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  public patch<T>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  public delete<T>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
