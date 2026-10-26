import { Router } from 'express';
import { shiftController } from '../controllers/shift.controller';
import { teamController } from '../controllers/team.controller';
import { billingController } from '../controllers/billing.controller';
import { authenticate } from '../middleware/authenticate';
import { requireTeamMembership, requireTeamPermission } from '../middleware/teamAuthorization';
import { validateRequest } from '../middleware/validateRequest';
import { Permission } from '../rbac/permissions';
import { billingTeamParamsSchema, checkoutBodySchema } from '../schemas/billing.schema';
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamMembersQuerySchema,
  teamIdParamSchema,
  teamMemberParamsSchema,
  teamMemberTargetParamsSchema,
  updateTeamMemberRoleSchema,
} from '../schemas/team.schema';
import {
  cancelShiftSchema,
  createShiftSchema,
  shiftListQuerySchema,
  shiftParamsSchema,
  shiftTargetParamsSchema,
  updateShiftSchema,
} from '../schemas/shift.schema';

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
router.get(
  '/:teamId/shifts',
  validateRequest({ params: shiftParamsSchema, query: shiftListQuerySchema }),
  requireTeamMembership,
  shiftController.list
);
router.post(
  '/:teamId/shifts',
  validateRequest({ params: shiftParamsSchema, body: createShiftSchema }),
  requireTeamPermission(Permission.MANAGE_OPERATIONAL_WORK),
  shiftController.create
);
router.patch(
  '/:teamId/shifts/:shiftId',
  validateRequest({ params: shiftTargetParamsSchema, body: updateShiftSchema }),
  requireTeamPermission(Permission.MANAGE_OPERATIONAL_WORK),
  shiftController.update
);
router.post(
  '/:teamId/shifts/:shiftId/cancel',
  validateRequest({ params: shiftTargetParamsSchema, body: cancelShiftSchema }),
  requireTeamPermission(Permission.MANAGE_OPERATIONAL_WORK),
  shiftController.cancel
);
router.get(
  '/:teamId/billing',
  validateRequest({ params: billingTeamParamsSchema }),
  requireTeamPermission(Permission.MANAGE_TEAM),
  billingController.teamBilling
);
router.post(
  '/:teamId/billing/checkout',
  validateRequest({ params: billingTeamParamsSchema, body: checkoutBodySchema }),
  requireTeamPermission(Permission.MANAGE_TEAM),
  billingController.checkout
);
router.get('/:id', validateRequest({ params: teamIdParamSchema }), teamController.get);

export default router;
