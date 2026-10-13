import { Request, Response } from 'express';
import { healthService } from '../services/health.service';

export const healthController = {
  getHealth(_req: Request, res: Response): void {
    const health = healthService.getHealthStatus();
    res.status(200).json(health);
  },
};
