import { Router } from 'express';
import { teamInvitationController } from '../controllers/team-invitation.controller';
import { authenticate } from '../middleware/authenticate';
import { validateRequest } from '../middleware/validateRequest';
import { tokenActionSchema } from '../schemas/team-invitation.schema';

const router = Router();

router.use(authenticate);

router.post(
  '/preview',
  validateRequest({ body: tokenActionSchema }),
  teamInvitationController.preview
);

router.post(
  '/accept',
  validateRequest({ body: tokenActionSchema }),
  teamInvitationController.accept
);

export default router;
