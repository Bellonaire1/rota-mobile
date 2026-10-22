import { ShiftStatus, TeamRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { runSerializable } from '../database/transactions';
import { AppError } from '../errors/AppError';
import {
  AddTeamMemberInput,
  CreateTeamInput,
  ListTeamMembersQuery,
  UpdateTeamMemberRoleInput,
} from '../schemas/team.schema';

const teamSelect = {
  id: true,
  name: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: { id: true, email: true, name: true },
  },
} as const;

const assertOwner = async (
  transaction: Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<void> => {
  const membership = await transaction.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw new AppError(404, 'Team not found');
  }
  if (membership.role !== TeamRole.OWNER) {
    throw new AppError(403, 'Insufficient team permissions');
  }
};

const assertMemberTarget = (role: TeamRole | undefined): void => {
  if (!role) {
    throw new AppError(404, 'Team member not found');
  }
  if (role === TeamRole.OWNER) {
    throw new AppError(403, 'Owners cannot be modified');
  }
};

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

  async listMembers(teamId: string, query: ListTeamMembersQuery) {
    const skip = (query.page - 1) * query.limit;
    const [total, members] = await prisma.$transaction([
      prisma.teamMembership.count({ where: { teamId } }),
      prisma.teamMembership.findMany({
        where: { teamId },
        select: memberSelect,
        orderBy: { createdAt: 'asc' },
        skip,
        take: query.limit,
      }),
    ]);

    return {
      members,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async addMember(teamId: string, actorId: string, input: AddTeamMemberInput) {
    try {
      return await prisma.$transaction(async (transaction) => {
        await assertOwner(transaction, teamId, actorId);

        const user = await transaction.user.findUnique({
          where: { id: input.userId },
          select: { id: true },
        });
        if (!user) {
          throw new AppError(404, 'User not found');
        }

        return transaction.teamMembership.create({
          data: { teamId, userId: input.userId, role: input.role },
          select: memberSelect,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(409, 'User is already a member of this team');
      }
      throw error;
    }
  },

  updateMemberRole(
    teamId: string,
    actorId: string,
    targetUserId: string,
    input: UpdateTeamMemberRoleInput
  ) {
    return prisma.$transaction(async (transaction) => {
      await assertOwner(transaction, teamId, actorId);
      const target = await transaction.teamMembership.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        select: { role: true },
      });
      assertMemberTarget(target?.role);

      return transaction.teamMembership.update({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        data: { role: input.role },
        select: memberSelect,
      });
    });
  },

  removeMember(teamId: string, actorId: string, targetUserId: string) {
    return runSerializable(async (transaction) => {
      await assertOwner(transaction, teamId, actorId);
      const target = await transaction.teamMembership.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        select: { role: true },
      });
      assertMemberTarget(target?.role);

      const futureShift = await transaction.shift.findFirst({
        where: {
          teamId,
          assignedToUserId: targetUserId,
          status: ShiftStatus.SCHEDULED,
          startsAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (futureShift) {
        throw new AppError(409, 'Member has future scheduled shifts; reassign or cancel them first');
      }

      await transaction.teamMembership.delete({
        where: { teamId_userId: { teamId, userId: targetUserId } },
      });
    });
  },
};
