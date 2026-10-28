import { Prisma, ShiftStatus, TeamRole } from '@prisma/client';
import { prisma } from '../database/prisma';
import { runSerializable } from '../database/transactions';
import { AppError } from '../errors/AppError';
import { Permission, hasPermission } from '../rbac/permissions';
import { assertOperationalMutationEntitlement, resolveSubscriptionEntitlement } from './subscription-entitlement.service';
import {
  CancelShiftInput,
  CreateShiftInput,
  ShiftListQuery,
  UpdateShiftInput,
} from '../schemas/shift.schema';

const shiftSelect = {
  id: true,
  teamId: true,
  assignedToUserId: true,
  createdByUserId: true,
  title: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelledAt: true,
  cancelledByUserId: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: { select: { id: true, email: true, name: true } },
  createdBy: { select: { id: true, email: true, name: true } },
} as const;

const assertPermission = async (
  transaction: Prisma.TransactionClient,
  teamId: string,
  userId: string,
  permission: Permission
): Promise<void> => {
  const membership = await transaction.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw new AppError(404, 'Team not found');
  }
  if (!hasPermission(membership.role, permission)) {
    throw new AppError(403, 'Insufficient team permissions');
  }
};

const assertAssignee = async (
  transaction: Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<void> => {
  const membership = await transaction.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { userId: true },
  });

  if (!membership) {
    throw new AppError(404, 'Shift assignee is not a member of this team');
  }
};

const assertTimeRange = (startsAt: Date, endsAt: Date): void => {
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration <= 0) {
    throw new AppError(400, 'Shift end must be after shift start');
  }
  if (duration > 24 * 60 * 60 * 1000) {
    throw new AppError(400, 'Shift duration must not exceed 24 hours');
  }
};

const assertNoOverlap = async (
  transaction: Prisma.TransactionClient,
  assignedToUserId: string,
  startsAt: Date,
  endsAt: Date,
  excludedShiftId?: string
): Promise<void> => {
  const overlap = await transaction.shift.findFirst({
    where: {
      assignedToUserId,
      status: ShiftStatus.SCHEDULED,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludedShiftId ? { id: { not: excludedShiftId } } : {}),
    },
    select: { id: true },
  });

  if (overlap) {
    throw new AppError(409, 'Shift overlaps another scheduled shift for this user');
  }
};

const assertFresh = (actual: Date, expected: Date): void => {
  if (actual.getTime() !== expected.getTime()) {
    throw new AppError(409, 'Shift has changed; reload before retrying');
  }
};

export const shiftService = {
  async create(teamId: string, actorId: string, input: CreateShiftInput) {
    return runSerializable(async (transaction) => {
      await assertPermission(transaction, teamId, actorId, Permission.MANAGE_OPERATIONAL_WORK);
      assertOperationalMutationEntitlement(await resolveSubscriptionEntitlement(transaction, teamId));
      await assertAssignee(transaction, teamId, input.assignedToUserId);
      await assertNoOverlap(transaction, input.assignedToUserId, input.startsAt, input.endsAt);

      return transaction.shift.create({
        data: {
          teamId,
          assignedToUserId: input.assignedToUserId,
          createdByUserId: actorId,
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
        select: shiftSelect,
      });
    });
  },

  async list(teamId: string, query: ShiftListQuery) {
    const skip = (query.page - 1) * query.limit;
    const where: Prisma.ShiftWhereInput = {
      teamId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            startsAt: query.to ? { lt: query.to } : undefined,
            endsAt: query.from ? { gt: query.from } : undefined,
          }
        : {}),
    };

    const [total, shifts] = await prisma.$transaction([
      prisma.shift.count({ where }),
      prisma.shift.findMany({
        where,
        select: shiftSelect,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip,
        take: query.limit,
      }),
    ]);

    return {
      shifts,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async update(
    teamId: string,
    shiftId: string,
    actorId: string,
    input: UpdateShiftInput
  ) {
    return runSerializable(async (transaction) => {
      await assertPermission(transaction, teamId, actorId, Permission.MANAGE_OPERATIONAL_WORK);
      assertOperationalMutationEntitlement(await resolveSubscriptionEntitlement(transaction, teamId));
      const shift = await transaction.shift.findFirst({
        where: { id: shiftId, teamId },
        select: {
          assignedToUserId: true,
          title: true,
          startsAt: true,
          endsAt: true,
          status: true,
          updatedAt: true,
        },
      });

      if (!shift) {
        throw new AppError(404, 'Shift not found');
      }
      assertFresh(shift.updatedAt, input.updatedAt);
      if (shift.status === ShiftStatus.CANCELLED) {
        throw new AppError(409, 'Cancelled shifts cannot be updated');
      }

      const startsAt = input.startsAt ?? shift.startsAt;
      const endsAt = input.endsAt ?? shift.endsAt;
      const assignedToUserId = input.assignedToUserId ?? shift.assignedToUserId;
      assertTimeRange(startsAt, endsAt);
      await assertAssignee(transaction, teamId, assignedToUserId);
      await assertNoOverlap(transaction, assignedToUserId, startsAt, endsAt, shiftId);

      const updated = await transaction.shift.updateMany({
        where: { id: shiftId, teamId, updatedAt: input.updatedAt },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          assignedToUserId,
          startsAt,
          endsAt,
        },
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'Shift has changed; reload before retrying');
      }

      return transaction.shift.findUniqueOrThrow({ where: { id: shiftId }, select: shiftSelect });
    });
  },

  async cancel(teamId: string, shiftId: string, actorId: string, input: CancelShiftInput) {
    return runSerializable(async (transaction) => {
      await assertPermission(transaction, teamId, actorId, Permission.MANAGE_OPERATIONAL_WORK);
      assertOperationalMutationEntitlement(await resolveSubscriptionEntitlement(transaction, teamId));
      const shift = await transaction.shift.findFirst({
        where: { id: shiftId, teamId },
        select: { status: true, updatedAt: true },
      });

      if (!shift) {
        throw new AppError(404, 'Shift not found');
      }
      assertFresh(shift.updatedAt, input.updatedAt);
      if (shift.status === ShiftStatus.CANCELLED) {
        throw new AppError(409, 'Shift is already cancelled');
      }

      const updated = await transaction.shift.updateMany({
        where: { id: shiftId, teamId, updatedAt: input.updatedAt },
        data: {
          status: ShiftStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: actorId,
        },
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'Shift has changed; reload before retrying');
      }

      return transaction.shift.findUniqueOrThrow({ where: { id: shiftId }, select: shiftSelect });
    });
  },
};
