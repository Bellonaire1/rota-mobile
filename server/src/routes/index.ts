import { Router } from 'express';
import healthRoutes from './health.routes';

const router = Router();

// Mount health routes at /api/v1/health
router.use('/health', healthRoutes);

export default router;
