import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/authenticate';
import { validateRequest } from '../middleware/validateRequest';
import {
  loginSchema,
  refreshTokenSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
} from '../schemas/auth.schema';

const router = Router();

router.post('/register', validateRequest({ body: registerSchema }), authController.register);
router.post('/login', validateRequest({ body: loginSchema }), authController.login);
router.post('/refresh', validateRequest({ body: refreshTokenSchema }), authController.refresh);
router.post('/logout', validateRequest({ body: refreshTokenSchema }), authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);
router.get('/me', authenticate, authController.me);
router.post(
  '/password-reset/request',
  validateRequest({ body: passwordResetRequestSchema }),
  authController.requestPasswordReset
);
router.post(
  '/password-reset/confirm',
  validateRequest({ body: passwordResetConfirmSchema }),
  authController.confirmPasswordReset
);

export default router;
