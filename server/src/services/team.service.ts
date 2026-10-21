import { TeamRole } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AppError } from '../errors/AppError';
import { CreateTeamInput } from '../schemas/team.schema';

const teamSelect = {
  id: true,
  name: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const teamService = {
  async create(input: CreateTeamInput, userId: string) {
    return prisma.$transaction(async (transaction) => {
      const team = await transaction.team.create({
        data: {
          name: input.name,
          createdByUserId: userId,
        },
        select: teamSelect,
      });

      await transaction.teamMembership.create({
        data: {
          teamId: team.id,
          userId,
          role: TeamRole.OWNER,
        },
      });

      return team;
    });
  },

  listForUser(userId: string) {
    return prisma.team.findMany({
      where: {
        memberships: {
          some: { userId },
        },
      },
      select: teamSelect,
      orderBy: { createdAt: 'asc' },
    });
  },

  async getForUser(teamId: string, userId: string) {
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        memberships: {
          some: { userId },
        },
      },
      select: teamSelect,
    });

    if (!team) {
      throw new AppError(404, 'Team not found');
    }

    return team;
  },
};
