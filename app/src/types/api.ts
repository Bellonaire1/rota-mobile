export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error';
  data?: T;
  message?: string;
}

export interface HealthCheckResponse {
  status: 'ok';
  message: string;
  timestamp: string;
  uptime: number;
}

export interface ApiErrorResponse {
  status: 'error';
  message: string;
  errors?: Array<{
    field?: string;
    message: string;
  }>;
}
