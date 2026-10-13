import { apiClient } from './apiClient';
import { HealthCheckResponse } from '@/types/api';

export const healthService = {
  /**
   * Fetches health status from backend /health endpoint.
   */
  async checkHealth(): Promise<HealthCheckResponse> {
    return apiClient.get<HealthCheckResponse>('/health');
  },
};
