import { Router } from 'express';
import { teamController } from '../controllers/team.controller';
import { authenticate } from '../middleware/authenticate';
import { requireTeamMembership, requireTeamPermission } from '../middleware/teamAuthorization';
import { validateRequest } from '../middleware/validateRequest';
import { Permission } from '../rbac/permissions';
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamMembersQuerySchema,
  teamIdParamSchema,
  teamMemberParamsSchema,
  teamMemberTargetParamsSchema,
  updateTeamMemberRoleSchema,
} from '../schemas/team.schema';

const router = Router();

router.use(authenticate);
router.post('/', validateRequest({ body: createTeamSchema }), teamController.create);
router.get('/', teamController.list);
router.get(
  '/:teamId/members',
  validateRequest({ params: teamMemberParamsSchema, query: listTeamMembersQuerySchema }),
  requireTeamMembership,
  teamController.listMembers
);
router.post(
  '/:teamId/members',
  validateRequest({ params: teamMemberParamsSchema, body: addTeamMemberSchema }),
  requireTeamPermission(Permission.MANAGE_TEAM),
  teamController.addMember
);
router.patch(
  '/:teamId/members/:userId/role',
  validateRequest({ params: teamMemberTargetParamsSchema, body: updateTeamMemberRoleSchema }),
  requireTeamPermission(Permission.MANAGE_TEAM),
  teamController.updateMemberRole
);
router.delete(
  '/:teamId/members/:userId',
  validateRequest({ params: teamMemberTargetParamsSchema }),
  requireTeamPermission(Permission.MANAGE_TEAM),
  teamController.removeMember
);
router.get('/:id', validateRequest({ params: teamIdParamSchema }), teamController.get);

export default router;
