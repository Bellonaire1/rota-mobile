import { Request, Response, NextFunction } from 'express';
import { prisma } from '../database/prisma';
import { AppError } from '../errors/AppError';
import { Permission, hasPermission } from '../rbac/permissions';

const teamIdFromRequest = (req: Request): string | undefined =>
  req.params.teamId ?? req.params.id;

const authorizeTeamMembership = async (req: Request) => {
  const teamId = teamIdFromRequest(req);
  const userId = req.auth?.userId;

  if (!teamId || !userId) {
    throw new AppError(404, 'Team not found');
  }

  const membership = await prisma.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { teamId: true, userId: true, role: true },
  });

  if (!membership) {
    throw new AppError(404, 'Team not found');
  }

  req.teamMembership = membership;
  return membership;
};

export const requireTeamMembership = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await authorizeTeamMembership(req);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireTeamPermission = (permission: Permission) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const membership = await authorizeTeamMembership(req);

      if (!hasPermission(membership.role, permission)) {
        throw new AppError(403, 'Insufficient team permissions');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
