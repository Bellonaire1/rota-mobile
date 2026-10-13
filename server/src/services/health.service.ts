export interface HealthStatus {
  status: 'ok';
  message: string;
  timestamp: string;
  uptime: number;
  environment: string;
}

export const healthService = {
  getHealthStatus(): HealthStatus {
    return {
      status: 'ok',
      message: 'Rota API is running',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
    };
  },
};
