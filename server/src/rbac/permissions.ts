import { TeamRole } from '@prisma/client';

export enum Permission {
  VIEW_OPERATIONAL_WORK = 'view:operational-work',
  MANAGE_OPERATIONAL_WORK = 'manage:operational-work',
  MANAGE_STAFF = 'manage:staff',
  MANAGE_MANAGERS = 'manage:managers',
  MANAGE_TEAM = 'manage:team',
}

const rolePermissions: Record<TeamRole, readonly Permission[]> = {
  [TeamRole.OWNER]: Object.values(Permission),
  [TeamRole.MANAGER]: [
    Permission.VIEW_OPERATIONAL_WORK,
    Permission.MANAGE_OPERATIONAL_WORK,
    Permission.MANAGE_STAFF,
  ],
  [TeamRole.STAFF]: [Permission.VIEW_OPERATIONAL_WORK],
};

export const hasPermission = (
  role: TeamRole,
  permission: Permission
): boolean => {
  const permissions = rolePermissions[role];

  if (!permissions || !Object.values(Permission).includes(permission)) {
    return false;
  }

  return permissions.includes(permission);
};

export { TeamRole };
