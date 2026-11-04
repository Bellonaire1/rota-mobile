import crypto from 'node:crypto';
import { ActivityEventType, TeamRole } from '@prisma/client';
import { prisma } from '../database/prisma';
import { runSerializable } from '../database/transactions';
import { AppError } from '../errors/AppError';
import { CreateInvitationInput } from '../schemas/team-invitation.schema';
import { emailService } from './email';
import { activityService } from './activity.service';
import {
  assertMembershipSeatEntitlement,
  resolveSubscriptionEntitlement,
} from './subscription-entitlement.service';

export interface TeamInvitationResponse {
  id: string;
  teamId: string;
  invitedEmail: string;
  role: TeamRole;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
}

export interface InvitationPreviewResponse {
  id: string;
  teamId: string;
  teamName: string;
  invitedEmail: string;
  role: TeamRole;
  inviterName: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface InvitationAcceptResponse {
  membership: {
    id: string;
    teamId: string;
    userId: string;
    role: TeamRole;
    createdAt: Date;
    updatedAt: Date;
  };
  team: {
    id: string;
    name: string;
  };
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_INVITATIONS_PER_WINDOW = 10;

const assertOwner = async (teamId: string, userId: string): Promise<void> => {
  const membership = await prisma.teamMembership.findUnique({
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

export const teamInvitationService = {
  /**
   * Team OWNER invites a person by email.
   * Enforces OWNER authorization, validates seat entitlements, checks duplicate active invites,
   * enforces persistent rate limits, delivers email, and stores only the SHA-256 token hash.
   */
  async create(
    teamId: string,
    actorUserId: string,
    input: CreateInvitationInput
  ): Promise<TeamInvitationResponse> {
    await assertOwner(teamId, actorUserId);

    const normalizedEmail = input.email.trim().toLowerCase();

    // 1. Enforce persistent rate limit on invitation creations
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    const recentCount = await prisma.teamInvitation.count({
      where: {
        teamId,
        createdAt: { gte: windowStart },
      },
    });

    if (recentCount >= MAX_INVITATIONS_PER_WINDOW) {
      throw new AppError(429, 'Too many invitations created recently. Please try again later.');
    }

    // 2. Reject existing team members
    const existingMember = await prisma.teamMembership.findFirst({
      where: {
        teamId,
        user: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      },
      select: { id: true },
    });

    if (existingMember) {
      throw new AppError(409, 'User is already a member of this team');
    }

    // 3. Reject duplicate active (unaccepted, unrevoked, unexpired) invitations
    const now = new Date();
    const activeInvite = await prisma.teamInvitation.findFirst({
      where: {
        teamId,
        invitedEmail: normalizedEmail,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });

    if (activeInvite) {
      throw new AppError(409, 'An active invitation already exists for this email address');
    }

    // 4. Check seat entitlement
    const entitlement = await resolveSubscriptionEntitlement(prisma, teamId);
    assertMembershipSeatEntitlement(entitlement, entitlement.currentBillableStaffSeats + 1);

    // 5. Verify email provider is ready
    await emailService.verifyDeliveryAvailable();

    // 6. Clean up any expired pending invitations for this (teamId, email) to satisfy unique partial index
    await prisma.teamInvitation.updateMany({
      where: {
        teamId,
        invitedEmail: normalizedEmail,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { lte: now },
      },
      data: {
        revokedAt: now,
      },
    });

    // 7. Generate cryptographically secure random token (256 bits entropy)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    // 8. Fetch team and inviter metadata for email message
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });
    const inviter = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { name: true, email: true },
    });

    // 9. Persist invitation record
    const invitation = await prisma.teamInvitation.create({
      data: {
        teamId,
        invitedEmail: normalizedEmail,
        role: input.role,
        tokenHash,
        invitedByUserId: actorUserId,
        expiresAt,
      },
    });

    // 10. Deliver email via EmailService. If delivery fails, roll back persisted record immediately.
    try {
      await emailService.sendTeamInvitationEmail({
        to: normalizedEmail,
        teamName: team?.name || 'Your Team',
        inviterName: inviter?.name || inviter?.email || null,
        role: input.role,
        token: rawToken,
        expiresAt,
      });
    } catch (err: any) {
      await prisma.teamInvitation.delete({ where: { id: invitation.id } }).catch(() => {});
      throw new AppError(
        500,
        `Failed to deliver invitation email: ${err?.message || 'Email delivery error'}`
      );
    }

    return {
      id: invitation.id,
      teamId: invitation.teamId,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      status: 'PENDING',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    };
  },

  /**
   * Review invitation history for a team.
   * Accessible only to the team OWNER.
   * Never returns raw tokens or token hashes.
   */
  async list(teamId: string, actorUserId: string): Promise<TeamInvitationResponse[]> {
    await assertOwner(teamId, actorUserId);

    const invitations = await prisma.teamInvitation.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        teamId: true,
        invitedEmail: true,
        role: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });

    const now = new Date();
    return invitations.map((inv) => {
      let status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
      if (inv.acceptedAt) {
        status = 'ACCEPTED';
      } else if (inv.revokedAt) {
        status = 'REVOKED';
      } else if (inv.expiresAt <= now) {
        status = 'EXPIRED';
      } else {
        status = 'PENDING';
      }

      return {
        id: inv.id,
        teamId: inv.teamId,
        invitedEmail: inv.invitedEmail,
        role: inv.role,
        status,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
        acceptedAt: inv.acceptedAt,
        revokedAt: inv.revokedAt,
      };
    });
  },

  /**
   * Revoke an outstanding invitation.
   * Accessible only to the team OWNER.
   * Idempotent: revoking an already-revoked invitation succeeds safely.
   */
  async revoke(
    teamId: string,
    invitationId: string,
    actorUserId: string
  ): Promise<TeamInvitationResponse> {
    await assertOwner(teamId, actorUserId);

    const invitation = await prisma.teamInvitation.findFirst({
      where: { id: invitationId, teamId },
    });

    if (!invitation) {
      throw new AppError(404, 'Invitation not found');
    }

    if (invitation.acceptedAt) {
      throw new AppError(400, 'Cannot revoke an invitation that has already been accepted');
    }

    if (invitation.revokedAt) {
      return {
        id: invitation.id,
        teamId: invitation.teamId,
        invitedEmail: invitation.invitedEmail,
        role: invitation.role,
        status: 'REVOKED',
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
      };
    }

    const updated = await prisma.teamInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });

    return {
      id: updated.id,
      teamId: updated.teamId,
      invitedEmail: updated.invitedEmail,
      role: updated.role,
      status: 'REVOKED',
      createdAt: updated.createdAt,
      expiresAt: updated.expiresAt,
      acceptedAt: updated.acceptedAt,
      revokedAt: updated.revokedAt,
    };
  },

  /**
   * Preview invitation details for an authenticated user prior to acceptance.
   * Validates token hash, status, expiration, and ensures user email matches invited recipient.
   */
  async preview(token: string, currentUserId: string): Promise<InvitationPreviewResponse> {
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    const invitation = await prisma.teamInvitation.findUnique({
      where: { tokenHash },
      include: {
        team: { select: { id: true, name: true } },
        invitedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!invitation) {
      throw new AppError(404, 'Invitation not found or invalid');
    }

    // Constant-time comparison
    const computedBuf = Buffer.from(tokenHash, 'hex');
    const storedBuf = Buffer.from(invitation.tokenHash, 'hex');
    if (computedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(computedBuf, storedBuf)) {
      throw new AppError(404, 'Invitation not found or invalid');
    }

    // Status validations
    if (invitation.revokedAt) {
      throw new AppError(400, 'Invitation has been revoked');
    }
    if (invitation.acceptedAt) {
      throw new AppError(400, 'Invitation has already been accepted');
    }
    if (invitation.expiresAt <= new Date()) {
      throw new AppError(400, 'Invitation has expired');
    }

    // Identity validation
    const user = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new AppError(401, 'User not found');
    }

    if (user.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()) {
      throw new AppError(403, 'This invitation was issued to a different email address');
    }

    return {
      id: invitation.id,
      teamId: invitation.team.id,
      teamName: invitation.team.name,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      inviterName: invitation.invitedBy?.name || invitation.invitedBy?.email || 'Team Owner',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    };
  },

  /**
   * Accept an invitation and create membership atomically within a serializable transaction.
   * Enforces constant-time token verification, status checks, email identity matching,
   * row locking on team, rechecks existing membership & seat entitlement, records MEMBER_ADDED activity.
   */
  async accept(token: string, currentUserId: string): Promise<InvitationAcceptResponse> {
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    const invitation = await prisma.teamInvitation.findUnique({
      where: { tokenHash },
      include: {
        team: { select: { id: true, name: true } },
      },
    });

    if (!invitation) {
      throw new AppError(404, 'Invitation not found or invalid');
    }

    // Constant-time check
    const computedBuf = Buffer.from(tokenHash, 'hex');
    const storedBuf = Buffer.from(invitation.tokenHash, 'hex');
    if (computedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(computedBuf, storedBuf)) {
      throw new AppError(404, 'Invitation not found or invalid');
    }

    // Pre-flight status validations
    if (invitation.revokedAt) {
      throw new AppError(400, 'Invitation has been revoked');
    }
    if (invitation.acceptedAt) {
      throw new AppError(409, 'Invitation has already been accepted');
    }
    if (invitation.expiresAt <= new Date()) {
      throw new AppError(400, 'Invitation has expired');
    }

    // Verify authenticated user identity matches invitedEmail
    const user = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new AppError(401, 'User not found');
    }

    if (user.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()) {
      throw new AppError(403, 'Authenticated email does not match invitation recipient');
    }

    // Atomic execution within runSerializable transaction
    return await runSerializable(async (tx) => {
      // 1. Lock team row
      await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${invitation.teamId} FOR UPDATE`;

      // 2. Re-verify invitation state under transaction lock
      const inv = await tx.teamInvitation.findUnique({
        where: { id: invitation.id },
      });

      if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) {
        throw new AppError(409, 'Invitation is no longer valid, has expired, or has already been accepted');
      }

      // 3. Recheck existing membership
      const existingMembership = await tx.teamMembership.findUnique({
        where: { teamId_userId: { teamId: inv.teamId, userId: currentUserId } },
      });
      if (existingMembership) {
        throw new AppError(409, 'User is already a member of this team');
      }

      // 4. Recheck seat entitlement
      const entitlement = await resolveSubscriptionEntitlement(tx, inv.teamId);
      assertMembershipSeatEntitlement(entitlement, entitlement.currentBillableStaffSeats + 1);

      // 5. Consume token exactly once
      const updateCount = await tx.$executeRaw`
        UPDATE "TeamInvitation"
        SET "acceptedAt" = NOW(), "acceptedByUserId" = ${currentUserId}
        WHERE "id" = ${inv.id} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
      `;

      if (updateCount === 0) {
        throw new AppError(409, 'Invitation has already been accepted or revoked');
      }

      // 6. Create TeamMembership
      const createdMembership = await tx.teamMembership.create({
        data: {
          teamId: inv.teamId,
          userId: currentUserId,
          role: inv.role,
        },
        select: {
          id: true,
          teamId: true,
          userId: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // 7. Record MEMBER_ADDED activity event within the transaction
      await activityService.logEvent(tx, {
        teamId: inv.teamId,
        actorUserId: currentUserId,
        type: ActivityEventType.MEMBER_ADDED,
        entityType: 'MEMBERSHIP',
        entityId: createdMembership.id,
        metadata: {
          userId: currentUserId,
          userEmail: user.email,
          role: inv.role,
          invitationId: inv.id,
          invitedByUserId: inv.invitedByUserId,
          acceptedViaInvitation: true,
        },
      });

      return {
        membership: createdMembership,
        team: {
          id: invitation.team.id,
          name: invitation.team.name,
        },
      };
    });
  },
};
