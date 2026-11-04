import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it, beforeEach } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';
import { mockEmailProvider } from '../services/email';
import { ActivityEventType, TeamRole } from '@prisma/client';

interface AuthResponse {
  user?: { id: string; email: string; name?: string | null };
  accessToken?: string;
}

interface TeamResponse {
  team?: { id: string; name: string };
}

interface InvitationResponse {
  invitation?: {
    id: string;
    teamId: string;
    invitedEmail: string;
    role: string;
    status: string;
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string | null;
    revokedAt?: string | null;
  };
  invitations?: Array<{
    id: string;
    teamId: string;
    invitedEmail: string;
    role: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }>;
}

interface PreviewResponse {
  invitation?: {
    id: string;
    teamId: string;
    teamName: string;
    invitedEmail: string;
    role: string;
    inviterName: string;
    createdAt: string;
    expiresAt: string;
  };
}

interface AcceptResponse {
  membership?: {
    id: string;
    teamId: string;
    userId: string;
    role: string;
  };
  team?: {
    id: string;
    name: string;
  };
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, options);

const register = async (email?: string, name = 'Test User'): Promise<AuthResponse> => {
  const userEmail = email ?? `user-${randomUUID()}@example.com`;
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      name,
      password: 'correct horse battery staple',
    }),
  });
  const body = (await response.json()) as AuthResponse;
  if (body.user?.id) {
    createdUserIds.push(body.user.id);
  }
  return body;
};

const jsonRequest = (
  path: string,
  accessToken: string | undefined,
  body?: unknown,
  method = 'POST'
) =>
  request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createTeam = async (auth: AuthResponse, name = 'Invitation Test Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const skipReason = authIntegrationSkipReason();

describe('secure team invitations API & lifecycle', { concurrency: false, skip: skipReason }, () => {
  before(async () => {
    if (skipReason) return;
    const safetyCheck = authIntegrationSkipReason();
    if (safetyCheck) {
      throw new Error(`Safety guard rejected database connection: ${safetyCheck}`);
    }
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    if (skipReason) return;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    if (createdTeamIds.length > 0) {
      await prisma.billingSubscription.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamInvitation.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.activityEvent.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamMembership.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // Extract raw token from mock email message body
  const extractTokenFromEmail = (text: string): string => {
    const match = text.match(/token=([a-f0-9]{64})/i) || text.match(/([a-f0-9]{64})/);
    assert.ok(match, 'Token must be present in invitation email text');
    return match[1];
  };

  // 1. OWNER creates STAFF invite
  it('allows OWNER to create a STAFF invitation', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Staff Invite Team');
    const targetEmail = `staff-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as InvitationResponse;
    assert.ok(body.invitation?.id);
    assert.strictEqual(body.invitation?.invitedEmail, targetEmail.toLowerCase());
    assert.strictEqual(body.invitation?.role, 'STAFF');
    assert.strictEqual(body.invitation?.status, 'PENDING');
  });

  // 2. OWNER creates MANAGER invite
  it('allows OWNER to create a MANAGER invitation', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Manager Invite Team');
    const targetEmail = `manager-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as InvitationResponse;
    assert.ok(body.invitation?.id);
    assert.strictEqual(body.invitation?.role, 'MANAGER');
  });

  // 3. STAFF cannot create invite (403)
  it('forbids STAFF members from creating invitations (HTTP 403)', async () => {
    const owner = await register();
    const staff = await register();
    const teamId = await createTeam(owner, 'Staff Forbidden Team');

    // Add staff member
    await prisma.teamMembership.create({
      data: { teamId, userId: staff.user!.id, role: TeamRole.STAFF },
    });

    const res = await jsonRequest(`/teams/${teamId}/invitations`, staff.accessToken, {
      email: `invitee-${randomUUID()}@example.com`,
      role: 'STAFF',
    });

    assert.strictEqual(res.status, 403, 'STAFF must receive 403 when creating invitations');
  });

  // 4. Non-member cannot create invite (404)
  it('rejects non-members with anti-enumeration HTTP 404', async () => {
    const owner = await register();
    const nonMember = await register();
    const teamId = await createTeam(owner, 'NonMember Team');

    const res = await jsonRequest(`/teams/${teamId}/invitations`, nonMember.accessToken, {
      email: `target-${randomUUID()}@example.com`,
      role: 'STAFF',
    });

    assert.strictEqual(res.status, 404, 'Non-member must receive 404 anti-enumeration response');
  });

  // 5. OWNER role cannot be invited (400)
  it('rejects attempts to invite with OWNER role (HTTP 400)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Owner Role Attempt Team');

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: `owner-target-${randomUUID()}@example.com`,
      role: 'OWNER',
    });

    assert.strictEqual(res.status, 400, 'OWNER role invitation must be rejected with 400');
  });

  // 6. Existing member cannot be invited again (409)
  it('rejects invitation if recipient is already a team member (HTTP 409)', async () => {
    const owner = await register();
    const memberEmail = `existing-${randomUUID()}@example.com`;
    const member = await register(memberEmail);
    const teamId = await createTeam(owner, 'Existing Member Team');

    await prisma.teamMembership.create({
      data: { teamId, userId: member.user!.id, role: TeamRole.STAFF },
    });

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: memberEmail,
      role: 'STAFF',
    });

    assert.strictEqual(res.status, 409, 'Existing member invitation must return 409 Conflict');
  });

  // 7. Duplicate active invite rejected (409)
  it('rejects duplicate active invitation for same team and email (HTTP 409)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Duplicate Invite Team');
    const targetEmail = `duplicate-${randomUUID()}@example.com`;

    const first = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(first.status, 201);

    const second = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });
    assert.strictEqual(second.status, 409, 'Duplicate active invitation must return 409 Conflict');
  });

  // 8. Invitation email delivered to mock outbox
  it('delivers invitation email with required parameters to mock email provider', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Email Outbox Team');
    const targetEmail = `email-test-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const lastEmail = mockEmailProvider.getLastEmail();
    assert.ok(lastEmail, 'Email must have been sent');
    assert.strictEqual(lastEmail?.to, targetEmail.toLowerCase());
    assert.ok(lastEmail?.subject.includes('Email Outbox Team'));
    assert.ok(lastEmail?.text.includes('STAFF'));
    assert.ok(lastEmail?.text.includes('rota://invite?token='));
  });

  // 9. Raw token never stored in database
  it('stores only the SHA-256 hash in PostgreSQL and never the raw token', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Hash Only Team');
    const targetEmail = `token-hash-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const lastEmail = mockEmailProvider.getLastEmail();
    const rawToken = extractTokenFromEmail(lastEmail!.text);
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');

    const dbRecord = await prisma.teamInvitation.findFirst({
      where: { teamId, invitedEmail: targetEmail.toLowerCase() },
    });

    assert.ok(dbRecord);
    assert.strictEqual(dbRecord?.tokenHash, expectedHash);
    assert.notStrictEqual(dbRecord?.tokenHash, rawToken);
    assert.strictEqual(dbRecord?.tokenHash.length, 64);
  });

  // 10. Invitation preview succeeds for matching user
  it('allows authenticated invited user to preview invitation details', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Preview Team');
    const targetEmail = `preview-user-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail, 'Invited Person');

    const previewRes = await jsonRequest('/team-invitations/preview', invitedUser.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(previewRes.status, 200);
    const body = (await previewRes.json()) as PreviewResponse;
    assert.strictEqual(body.invitation?.teamName, 'Preview Team');
    assert.strictEqual(body.invitation?.role, 'MANAGER');
    assert.strictEqual(body.invitation?.invitedEmail, targetEmail.toLowerCase());
    assert.strictEqual((body.invitation as any)?.tokenHash, undefined, 'tokenHash must not be exposed in preview');
  });

  // 11. Wrong-email user cannot accept (403)
  it('forbids users with non-matching email from accepting invitation (HTTP 403)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Wrong Email Team');
    const targetEmail = `correct-${randomUUID()}@example.com`;
    const wrongEmail = `wrong-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const imposter = await register(wrongEmail, 'Imposter User');

    const acceptRes = await jsonRequest('/team-invitations/accept', imposter.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(acceptRes.status, 403, 'Accepting with wrong email must return 403 Forbidden');
  });

  // 12. Expired token rejected (400)
  it('rejects acceptance of expired invitation tokens (HTTP 400)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Expired Token Team');
    const targetEmail = `expired-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    // Manually expire token in database
    await prisma.teamInvitation.updateMany({
      where: { teamId, invitedEmail: targetEmail.toLowerCase() },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(acceptRes.status, 400, 'Expired token acceptance must return 400');
  });

  // 13. Revoked token rejected (400)
  it('rejects acceptance of revoked invitations (HTTP 400)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Revoked Token Team');
    const targetEmail = `revoked-${randomUUID()}@example.com`;

    const createRes = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    const invId = ((await createRes.json()) as InvitationResponse).invitation!.id;
    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    // Owner revokes invitation
    const revokeRes = await jsonRequest(
      `/teams/${teamId}/invitations/${invId}/revoke`,
      owner.accessToken,
      {}
    );
    assert.strictEqual(revokeRes.status, 200);

    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(acceptRes.status, 400, 'Revoked invitation acceptance must return 400');
  });

  // 14. Valid acceptance creates correct membership
  it('successfully creates team membership on valid acceptance', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Accept Valid Team');
    const targetEmail = `valid-accept-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail, 'Valid Member');

    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(acceptRes.status, 200);
    const body = (await acceptRes.json()) as AcceptResponse;
    assert.strictEqual(body.membership?.role, 'MANAGER');
    assert.strictEqual(body.membership?.teamId, teamId);
    assert.strictEqual(body.membership?.userId, invitedUser.user!.id);

    // Verify database record
    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: invitedUser.user!.id } },
    });
    assert.ok(membership);
    assert.strictEqual(membership?.role, TeamRole.MANAGER);

    // Verify invitation marked accepted
    const inviteInDb = await prisma.teamInvitation.findFirst({
      where: { teamId, invitedEmail: targetEmail.toLowerCase() },
    });
    assert.ok(inviteInDb?.acceptedAt);
    assert.strictEqual(inviteInDb?.acceptedByUserId, invitedUser.user!.id);
  });

  // 15. Second acceptance cannot create duplicate membership (409)
  it('prevents reusing an already-accepted invitation token (HTTP 409)', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Double Accept Team');
    const targetEmail = `double-accept-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    const firstAccept = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });
    assert.strictEqual(firstAccept.status, 200);

    const secondAccept = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });
    assert.strictEqual(secondAccept.status, 409, 'Reusing token must return 409 Conflict');
  });

  // 16. Concurrent acceptance remains atomic
  it('maintains strict atomicity under concurrent acceptance requests', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Concurrent Accept Team');
    const targetEmail = `concurrent-accept-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    // Fire 2 concurrent acceptance requests
    const [res1, res2] = await Promise.all([
      jsonRequest('/team-invitations/accept', invitedUser.accessToken, { token: rawToken }),
      jsonRequest('/team-invitations/accept', invitedUser.accessToken, { token: rawToken }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], 'Exactly one request must succeed (200) and the other fail with 409');

    // Confirm exactly 1 membership in database
    const count = await prisma.teamMembership.count({
      where: { teamId, userId: invitedUser.user!.id },
    });
    assert.strictEqual(count, 1, 'Only one membership record may be created');
  });

  // 17. Seat entitlement checked at acceptance
  it('re-verifies subscription seat entitlement during acceptance', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Entitlement Team');
    const targetEmail = `seat-test-${randomUUID()}@example.com`;

    // Create invite
    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    // Mock subscription suspended in database
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    const plan = await prisma.billingPlan.upsert({
      where: { code: 'STARTER' },
      update: {},
      create: {
        code: 'STARTER',
        displayName: 'STARTER',
        active: true,
      },
    });
    const price = await prisma.billingPlanPrice.upsert({
      where: {
        planId_effectiveFrom: {
          planId: plan.id,
          effectiveFrom,
        },
      },
      update: {},
      create: {
        planId: plan.id,
        monthlyPriceCents: 2000,
        includedStaffSeats: 5,
        extraStaffSeatPriceCents: 0,
        currency: 'USD',
        effectiveFrom,
      },
    });

    await prisma.billingSubscription.create({
      data: {
        teamId,
        planId: plan.id,
        priceId: price.id,
        status: 'SUSPENDED',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });

    assert.strictEqual(acceptRes.status, 409, 'Suspended subscription must reject acceptance with 409');
  });

  // 18. Failed invitation does not create membership
  it('guarantees no membership is created if invitation acceptance fails', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Failed Invite Team');
    const targetEmail = `failed-invite-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const invitedUser = await register(targetEmail);

    // Attempt accept with corrupted token
    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: 'corrupted-invalid-token-string-here',
    });

    assert.strictEqual(acceptRes.status, 404);

    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: invitedUser.user!.id } },
    });
    assert.strictEqual(membership, null, 'No membership must be created on failure');
  });

  // 19. No raw token appears in API response
  it('never discloses raw invitation token or tokenHash in API responses', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'No Disclosure Team');
    const targetEmail = `privacy-${randomUUID()}@example.com`;

    // 1. Create response
    const createRes = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    const createBody = await createRes.json();
    assert.strictEqual((createBody as any).invitation?.token, undefined);
    assert.strictEqual((createBody as any).invitation?.tokenHash, undefined);

    // 2. List response
    const listRes = await request(`/teams/${teamId}/invitations`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const listBody = (await listRes.json()) as InvitationResponse;
    for (const inv of listBody.invitations || []) {
      assert.strictEqual((inv as any).token, undefined);
      assert.strictEqual((inv as any).tokenHash, undefined);
    }
  });

  // 20. Activity audit event created on acceptance
  it('records MEMBER_ADDED activity event upon invitation acceptance', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Audit Activity Team');
    const targetEmail = `activity-test-${randomUUID()}@example.com`;

    await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const invitedUser = await register(targetEmail);

    const acceptRes = await jsonRequest('/team-invitations/accept', invitedUser.accessToken, {
      token: rawToken,
    });
    assert.strictEqual(acceptRes.status, 200);

    const event = await prisma.activityEvent.findFirst({
      where: {
        teamId,
        type: ActivityEventType.MEMBER_ADDED,
        actorUserId: invitedUser.user!.id,
      },
    });

    assert.ok(event, 'MEMBER_ADDED event must be recorded in activity feed');
    assert.strictEqual(event?.entityType, 'MEMBERSHIP');
    const metadata = event?.metadata as any;
    assert.strictEqual(metadata?.userEmail, targetEmail.toLowerCase());
    assert.strictEqual(metadata?.role, 'STAFF');
    assert.strictEqual(metadata?.acceptedViaInvitation, true);
  });
});
