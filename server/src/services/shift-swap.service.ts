import { Prisma, ShiftStatus, ShiftSwapStatus, TeamRole } from '@prisma/client';
import { prisma } from '../database/prisma';
import { runSerializable } from '../database/transactions';
import { AppError } from '../errors/AppError';
import { Permission, hasPermission } from '../rbac/permissions';
import {
  CreateShiftSwapInput,
  RespondShiftSwapInput,
  ReviewShiftSwapInput,
  ShiftSwapListQuery,
} from '../schemas/shift-swap.schema';
import {
  assertOperationalMutationEntitlement,
  resolveSubscriptionEntitlement,
} from './subscription-entitlement.service';

const shiftSwapSelect = {
  id: true,
  teamId: true,
  sourceShiftId: true,
  targetShiftId: true,
  requestingUserId: true,
  receivingUserId: true,
  sourceShiftUpdatedAt: true,
  targetShiftUpdatedAt: true,
  status: true,
  peerRespondedAt: true,
  reviewedByUserId: true,
  reviewedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
  sourceShift: {
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      status: true,
      assignedToUserId: true,
      assignedTo: { select: { id: true, email: true, name: true } },
    },
  },
  targetShift: {
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      status: true,
      assignedToUserId: true,
      assignedTo: { select: { id: true, email: true, name: true } },
    },
  },
  requestingUser: { select: { id: true, email: true, name: true } },
  receivingUser: { select: { id: true, email: true, name: true } },
  reviewedByUser: { select: { id: true, email: true, name: true } },
} as const;

export const shiftSwapService = {
  async create(teamId: string, actorId: string, input: CreateShiftSwapInput) {
    return runSerializable(async (transaction) => {
      // 1. Fetch both shifts and verify team membership & ownership
      const [sourceShift, targetShift] = await Promise.all([
        transaction.shift.findFirst({
          where: { id: input.sourceShiftId, teamId },
        }),
        transaction.shift.findFirst({
          where: { id: input.targetShiftId, teamId },
        }),
      ]);

      if (!sourceShift || !targetShift) {
        throw new AppError(404, 'One or both shifts not found in this team');
      }

      if (
        sourceShift.status !== ShiftStatus.SCHEDULED ||
        targetShift.status !== ShiftStatus.SCHEDULED
      ) {
        throw new AppError(400, 'Both shifts must be scheduled to propose a swap');
      }

      if (sourceShift.assignedToUserId !== actorId) {
        throw new AppError(403, 'You can only request swaps for shifts assigned to you');
      }

      if (targetShift.assignedToUserId === actorId) {
        throw new AppError(400, 'Cannot swap shifts with yourself');
      }

      // 2. Verify both staff members currently belong to the team
      const [sourceMembership, targetMembership] = await Promise.all([
        transaction.teamMembership.findUnique({
          where: { teamId_userId: { teamId, userId: actorId } },
        }),
        transaction.teamMembership.findUnique({
          where: { teamId_userId: { teamId, userId: targetShift.assignedToUserId } },
        }),
      ]);

      if (!sourceMembership || !targetMembership) {
        throw new AppError(400, 'Both shift owners must be active members of this team');
      }

      // 3. Prevent duplicate / conflicting unresolved requests involving either shift
      const existingActiveSwap = await transaction.shiftSwapRequest.findFirst({
        where: {
          teamId,
          status: { in: [ShiftSwapStatus.PENDING_PEER, ShiftSwapStatus.PENDING_MANAGER] },
          OR: [
            { sourceShiftId: { in: [input.sourceShiftId, input.targetShiftId] } },
            { targetShiftId: { in: [input.sourceShiftId, input.targetShiftId] } },
          ],
        },
      });

      if (existingActiveSwap) {
        throw new AppError(409, 'One or both shifts are already involved in an active swap request');
      }

      // 4. Create the shift swap request
      return transaction.shiftSwapRequest.create({
        data: {
          teamId,
          sourceShiftId: sourceShift.id,
          targetShiftId: targetShift.id,
          requestingUserId: actorId,
          receivingUserId: targetShift.assignedToUserId,
          sourceShiftUpdatedAt: sourceShift.updatedAt,
          targetShiftUpdatedAt: targetShift.updatedAt,
          status: ShiftSwapStatus.PENDING_PEER,
        },
        select: shiftSwapSelect,
      });
    });
  },

  async list(teamId: string, actorId: string, actorRole: TeamRole, query: ShiftSwapListQuery) {
    const skip = (query.page - 1) * query.limit;

    const where: Prisma.ShiftSwapRequestWhereInput = {
      teamId,
      ...(query.status ? { status: query.status } : {}),
    };

    // Staff only sees requests where they are the requester or recipient
    if (actorRole === TeamRole.STAFF) {
      where.OR = [
        { requestingUserId: actorId },
        { receivingUserId: actorId },
      ];
    }

    const [total, shiftSwaps] = await prisma.$transaction([
      prisma.shiftSwapRequest.count({ where }),
      prisma.shiftSwapRequest.findMany({
        where,
        select: shiftSwapSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    return {
      shiftSwaps,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async respond(teamId: string, swapId: string, actorId: string, input: RespondShiftSwapInput) {
    return runSerializable(async (transaction) => {
      const swap = await transaction.shiftSwapRequest.findFirst({
        where: { id: swapId, teamId },
      });

      if (!swap) {
        throw new AppError(404, 'Shift swap request not found');
      }

      if (swap.receivingUserId !== actorId) {
        throw new AppError(403, 'Only the intended recipient can respond to this swap request');
      }

      if (swap.status !== ShiftSwapStatus.PENDING_PEER) {
        throw new AppError(409, 'Swap request is no longer pending peer response');
      }

      const nextStatus =
        input.action === 'accept'
          ? ShiftSwapStatus.PENDING_MANAGER
          : ShiftSwapStatus.DECLINED;

      return transaction.shiftSwapRequest.update({
        where: { id: swapId },
        data: {
          status: nextStatus,
          peerRespondedAt: new Date(),
        },
        select: shiftSwapSelect,
      });
    });
  },

  async review(teamId: string, swapId: string, actorId: string, input: ReviewShiftSwapInput) {
    return runSerializable(async (transaction) => {
      // 1. Subscription entitlement check for operational mutations
      assertOperationalMutationEntitlement(await resolveSubscriptionEntitlement(transaction, teamId));

      const swap = await transaction.shiftSwapRequest.findFirst({
        where: { id: swapId, teamId },
      });

      if (!swap) {
        throw new AppError(404, 'Shift swap request not found');
      }

      if (swap.status === ShiftSwapStatus.PENDING_PEER) {
        throw new AppError(409, 'Cannot review a swap request pending peer acceptance');
      }

      if (swap.status !== ShiftSwapStatus.PENDING_MANAGER) {
        throw new AppError(409, 'Swap request has already been resolved');
      }

      // Handle Rejection
      if (input.action === 'reject') {
        return transaction.shiftSwapRequest.update({
          where: { id: swapId },
          data: {
            status: ShiftSwapStatus.REJECTED,
            reviewedByUserId: actorId,
            reviewedAt: new Date(),
            rejectionReason: input.reason || null,
          },
          select: shiftSwapSelect,
        });
      }

      // Handle Approval
      // 2. Fetch fresh shifts and validate consistency & concurrency snapshots
      const [sourceShift, targetShift] = await Promise.all([
        transaction.shift.findFirst({
          where: { id: swap.sourceShiftId, teamId },
        }),
        transaction.shift.findFirst({
          where: { id: swap.targetShiftId, teamId },
        }),
      ]);

      if (!sourceShift || !targetShift) {
        throw new AppError(409, 'One or both shifts no longer exist');
      }

      if (
        sourceShift.status !== ShiftStatus.SCHEDULED ||
        targetShift.status !== ShiftStatus.SCHEDULED
      ) {
        throw new AppError(409, 'Cannot approve swap: one or both shifts have been cancelled');
      }

      if (
        sourceShift.assignedToUserId !== swap.requestingUserId ||
        targetShift.assignedToUserId !== swap.receivingUserId
      ) {
        throw new AppError(409, 'Cannot approve swap: shift assignees have changed');
      }

      if (
        sourceShift.updatedAt.getTime() !== swap.sourceShiftUpdatedAt.getTime() ||
        targetShift.updatedAt.getTime() !== swap.targetShiftUpdatedAt.getTime()
      ) {
        throw new AppError(
          409,
          'Cannot approve swap: shift schedule has been modified since request was created'
        );
      }

      // 3. Confirm both users still hold active memberships in this team
      const [requesterMembership, recipientMembership] = await Promise.all([
        transaction.teamMembership.findUnique({
          where: { teamId_userId: { teamId, userId: swap.requestingUserId } },
        }),
        transaction.teamMembership.findUnique({
          where: { teamId_userId: { teamId, userId: swap.receivingUserId } },
        }),
      ]);

      if (!requesterMembership || !recipientMembership) {
        throw new AppError(409, 'Cannot approve swap: one or both users are no longer team members');
      }

      // 4. Overlap detection for BOTH resulting assignees against their other scheduled shifts
      // Requester gets targetShift: check against other shifts assigned to requester (excluding sourceShift)
      const requesterOverlap = await transaction.shift.findFirst({
        where: {
          teamId,
          assignedToUserId: swap.requestingUserId,
          status: ShiftStatus.SCHEDULED,
          id: { not: swap.sourceShiftId },
          startsAt: { lt: targetShift.endsAt },
          endsAt: { gt: targetShift.startsAt },
        },
        select: { id: true, title: true },
      });

      if (requesterOverlap) {
        throw new AppError(
          409,
          'Swap would cause a schedule overlap for the requesting staff member'
        );
      }

      // Recipient gets sourceShift: check against other shifts assigned to recipient (excluding targetShift)
      const recipientOverlap = await transaction.shift.findFirst({
        where: {
          teamId,
          assignedToUserId: swap.receivingUserId,
          status: ShiftStatus.SCHEDULED,
          id: { not: swap.targetShiftId },
          startsAt: { lt: sourceShift.endsAt },
          endsAt: { gt: sourceShift.startsAt },
        },
        select: { id: true, title: true },
      });

      if (recipientOverlap) {
        throw new AppError(
          409,
          'Swap would cause a schedule overlap for the receiving staff member'
        );
      }

      // 5. Atomically exchange shift assignments
      await transaction.shift.update({
        where: { id: sourceShift.id },
        data: { assignedToUserId: swap.receivingUserId },
      });

      await transaction.shift.update({
        where: { id: targetShift.id },
        data: { assignedToUserId: swap.requestingUserId },
      });

      // 6. Update this swap request to APPROVED
      const approvedSwap = await transaction.shiftSwapRequest.update({
        where: { id: swap.id },
        data: {
          status: ShiftSwapStatus.APPROVED,
          reviewedByUserId: actorId,
          reviewedAt: new Date(),
        },
        select: shiftSwapSelect,
      });

      // 7. Invalidate any competing pending swap requests involving either shift
      await transaction.shiftSwapRequest.updateMany({
        where: {
          teamId,
          id: { not: swap.id },
          status: { in: [ShiftSwapStatus.PENDING_PEER, ShiftSwapStatus.PENDING_MANAGER] },
          OR: [
            { sourceShiftId: { in: [swap.sourceShiftId, swap.targetShiftId] } },
            { targetShiftId: { in: [swap.sourceShiftId, swap.targetShiftId] } },
          ],
        },
        data: {
          status: ShiftSwapStatus.CANCELLED,
          rejectionReason: 'Shift was swapped in another approved request',
        },
      });

      return approvedSwap;
    });
  },

  async cancel(teamId: string, swapId: string, actorId: string) {
    return runSerializable(async (transaction) => {
      const swap = await transaction.shiftSwapRequest.findFirst({
        where: { id: swapId, teamId },
      });

      if (!swap) {
        throw new AppError(404, 'Shift swap request not found');
      }

      if (swap.requestingUserId !== actorId) {
        throw new AppError(403, 'Only the requester can cancel this swap request');
      }

      if (
        swap.status !== ShiftSwapStatus.PENDING_PEER &&
        swap.status !== ShiftSwapStatus.PENDING_MANAGER
      ) {
        throw new AppError(409, 'Cannot cancel a resolved swap request');
      }

      return transaction.shiftSwapRequest.update({
        where: { id: swapId },
        data: {
          status: ShiftSwapStatus.CANCELLED,
        },
        select: shiftSwapSelect,
      });
    });
  },
};

