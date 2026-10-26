import { Router } from 'express';
import { billingController } from '../controllers/billing.controller';

const router = Router();

router.get('/plans', billingController.plans);

export default router;
