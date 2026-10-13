import { useState, useEffect, useCallback } from 'react';
import { healthService } from '@/services/api/healthService';
import { HealthCheckResponse } from '@/types/api';

export function useHealthCheck(autoCheck = false) {
  const [data, setData] = useState<HealthCheckResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await healthService.checkHealth();
      setData(response);
    } catch (err) {
      setError((err as Error).message || 'Failed to connect to backend server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoCheck) {
      check();
    }
  }, [autoCheck, check]);

  return { data, loading, error, check };
}
