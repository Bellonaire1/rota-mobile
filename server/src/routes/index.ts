import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import teamRoutes from './team.routes';
import billingRoutes from './billing.routes';

const router = Router();

// Mount health routes at /api/v1/health
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/teams', teamRoutes);
router.use('/billing', billingRoutes);

export default router;
