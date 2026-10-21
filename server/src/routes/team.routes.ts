import { Router } from 'express';
import { teamController } from '../controllers/team.controller';
import { authenticate } from '../middleware/authenticate';
import { validateRequest } from '../middleware/validateRequest';
import { createTeamSchema, teamIdParamSchema } from '../schemas/team.schema';

const router = Router();

router.use(authenticate);
router.post('/', validateRequest({ body: createTeamSchema }), teamController.create);
router.get('/', teamController.list);
router.get('/:id', validateRequest({ params: teamIdParamSchema }), teamController.get);

export default router;
