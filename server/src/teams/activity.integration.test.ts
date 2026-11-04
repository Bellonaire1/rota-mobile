import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';
import { ActivityEventType, TeamRole } from '@prisma/client';

interface AuthResponse {
  user?: { id: string; email: string; name: string | null };
  accessToken?: string;
}

interface TeamResponse {
  team?: { id: string };
}

interface ActivityEventResponse {
  id: string;
  teamId: string;
  actorUserId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor?: { id: string; name: string | null; email: string } | null;
}

interface ActivityFeedResponse {
  events?: ActivityEventResponse[];
  pagination?: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, options);

const register = async (name = 'Activity Test User'): Promise<AuthResponse> => {
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `activity-${randomUUID()}@example.com`,
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

const createTeam = async (auth: AuthResponse, name = 'Activity Feed Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const skipReason = authIntegrationSkipReason();

describe('activity feed API and event generation', { concurrency: false, skip: skipReason }, () => {
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
      await prisma.activityEvent.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.shiftSwapRequest.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.shift.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamMembership.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
  });

  it('generates SHIFT_CREATED, SHIFT_UPDATED, and SHIFT_CANCELLED activity events', async () => {
    const owner = await register('Shift Activity Owner');
    const staff = await register('Shift Activity Staff');
    const teamId = await createTeam(owner, 'Shift Activity Team');

    // Add staff member
    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staff.user!.id,
      role: 'STAFF',
    });

    // 1. Create Shift
    const createRes = await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Activity Morning Shift',
      assignedToUserId: staff.user!.id,
      startsAt: '2030-06-01T08:00:00.000Z',
      endsAt: '2030-06-01T16:00:00.000Z',
    });
    assert.strictEqual(createRes.status, 201);
    const { shift } = await createRes.json();

    // 2. Update Shift
    const updateRes = await jsonRequest(
      `/teams/${teamId}/shifts/${shift.id}`,
      owner.accessToken,
      {
        title: 'Activity Shift Renamed',
        updatedAt: shift.updatedAt,
      },
      'PATCH'
    );
    assert.strictEqual(updateRes.status, 200);
    const updatedShift = (await updateRes.json()).shift;

    // 3. Cancel Shift
    const cancelRes = await jsonRequest(
      `/teams/${teamId}/shifts/${shift.id}/cancel`,
      owner.accessToken,
      {
        updatedAt: updatedShift.updatedAt,
      }
    );
    assert.strictEqual(cancelRes.status, 200);

    // Fetch Activity Feed
    const feedRes = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(feedRes.status, 200);
    const feed = (await feedRes.json()) as ActivityFeedResponse;

    const eventTypes = feed.events!.map((e) => e.type);
    assert.ok(eventTypes.includes('SHIFT_CREATED'), 'feed must contain SHIFT_CREATED');
    assert.ok(eventTypes.includes('SHIFT_UPDATED'), 'feed must contain SHIFT_UPDATED');
    assert.ok(eventTypes.includes('SHIFT_CANCELLED'), 'feed must contain SHIFT_CANCELLED');

    const createdEvent = feed.events!.find((e) => e.type === 'SHIFT_CREATED');
    assert.strictEqual(createdEvent!.entityType, 'SHIFT');
    assert.strictEqual(createdEvent!.entityId, shift.id);
    assert.strictEqual(createdEvent!.actorUserId, owner.user!.id);
    assert.strictEqual(createdEvent!.actor?.email, owner.user!.email);
  });

  it('generates MEMBER_ADDED, MEMBER_ROLE_CHANGED, and MEMBER_REMOVED events', async () => {
    const owner = await register('Membership Activity Owner');
    const member = await register('Membership Activity Target');
    const teamId = await createTeam(owner, 'Membership Activity Team');

    // 1. Add Member
    const addRes = await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: member.user!.id,
      role: 'STAFF',
    });
    assert.strictEqual(addRes.status, 201);

    // 2. Role Change
    const roleRes = await jsonRequest(
      `/teams/${teamId}/members/${member.user!.id}/role`,
      owner.accessToken,
      { role: 'MANAGER' },
      'PATCH'
    );
    assert.strictEqual(roleRes.status, 200);

    // 3. Remove Member
    const removeRes = await request(`/teams/${teamId}/members/${member.user!.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(removeRes.status, 204);

    // Query Feed
    const feedRes = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(feedRes.status, 200);
    const feed = (await feedRes.json()) as ActivityFeedResponse;

    const eventTypes = feed.events!.map((e) => e.type);
    assert.ok(eventTypes.includes('MEMBER_ADDED'), 'feed must contain MEMBER_ADDED');
    assert.ok(eventTypes.includes('MEMBER_ROLE_CHANGED'), 'feed must contain MEMBER_ROLE_CHANGED');
    assert.ok(eventTypes.includes('MEMBER_REMOVED'), 'feed must contain MEMBER_REMOVED');
  });

  it('generates SWAP_REQUESTED, SWAP_PEER_ACCEPTED, and SWAP_APPROVED events', async () => {
    const owner = await register('Swap Activity Owner');
    const staffA = await register('Swap Activity Staff A');
    const staffB = await register('Swap Activity Staff B');
    const teamId = await createTeam(owner, 'Swap Activity Team');

    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staffA.user!.id,
      role: 'STAFF',
    });
    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staffB.user!.id,
      role: 'STAFF',
    });

    const shift1Res = await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Swap S1',
      assignedToUserId: staffA.user!.id,
      startsAt: '2030-07-01T09:00:00.000Z',
      endsAt: '2030-07-01T17:00:00.000Z',
    });
    const shift2Res = await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Swap S2',
      assignedToUserId: staffB.user!.id,
      startsAt: '2030-07-02T09:00:00.000Z',
      endsAt: '2030-07-02T17:00:00.000Z',
    });
    const s1 = (await shift1Res.json()).shift;
    const s2 = (await shift2Res.json()).shift;

    // 1. Swap Requested
    const swapReqRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: s1.id,
      targetShiftId: s2.id,
    });
    assert.strictEqual(swapReqRes.status, 201);
    const swap = (await swapReqRes.json()).shiftSwap;

    // 2. Peer Accepted
    const respondRes = await jsonRequest(
      `/teams/${teamId}/shift-swaps/${swap.id}/respond`,
      staffB.accessToken,
      { action: 'accept' }
    );
    assert.strictEqual(respondRes.status, 200);

    // 3. Manager Approved
    const reviewRes = await jsonRequest(
      `/teams/${teamId}/shift-swaps/${swap.id}/review`,
      owner.accessToken,
      { action: 'approve' }
    );
    assert.strictEqual(reviewRes.status, 200);

    // Query Feed
    const feedRes = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${staffA.accessToken}` },
    });
    assert.strictEqual(feedRes.status, 200);
    const feed = (await feedRes.json()) as ActivityFeedResponse;

    const eventTypes = feed.events!.map((e) => e.type);
    assert.ok(eventTypes.includes('SWAP_REQUESTED'), 'feed must contain SWAP_REQUESTED');
    assert.ok(eventTypes.includes('SWAP_PEER_ACCEPTED'), 'feed must contain SWAP_PEER_ACCEPTED');
    assert.ok(eventTypes.includes('SWAP_APPROVED'), 'feed must contain SWAP_APPROVED');
  });

  it('generates SWAP_PEER_DECLINED, SWAP_REJECTED, and SWAP_CANCELLED events', async () => {
    const owner = await register('Swap Negative Owner');
    const staffA = await register('Swap Negative Staff A');
    const staffB = await register('Swap Negative Staff B');
    const teamId = await createTeam(owner, 'Swap Negative Team');

    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staffA.user!.id,
      role: 'STAFF',
    });
    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staffB.user!.id,
      role: 'STAFF',
    });

    const sA = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Dec A',
      assignedToUserId: staffA.user!.id,
      startsAt: '2030-08-01T09:00:00.000Z',
      endsAt: '2030-08-01T17:00:00.000Z',
    })).json()).shift;
    const sB = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Dec B',
      assignedToUserId: staffB.user!.id,
      startsAt: '2030-08-02T09:00:00.000Z',
      endsAt: '2030-08-02T17:00:00.000Z',
    })).json()).shift;

    // Decline workflow
    const swap1 = (await (await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: sA.id,
      targetShiftId: sB.id,
    })).json()).shiftSwap;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap1.id}/respond`, staffB.accessToken, {
      action: 'decline',
    });

    // Rejection workflow
    const sC = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Rej C',
      assignedToUserId: staffA.user!.id,
      startsAt: '2030-08-03T09:00:00.000Z',
      endsAt: '2030-08-03T17:00:00.000Z',
    })).json()).shift;
    const sD = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Rej D',
      assignedToUserId: staffB.user!.id,
      startsAt: '2030-08-04T09:00:00.000Z',
      endsAt: '2030-08-04T17:00:00.000Z',
    })).json()).shift;

    const swap2 = (await (await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: sC.id,
      targetShiftId: sD.id,
    })).json()).shiftSwap;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap2.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });
    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap2.id}/review`, owner.accessToken, {
      action: 'reject',
      reason: 'Understaffed during holidays',
    });

    // Cancellation workflow
    const sE = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Can E',
      assignedToUserId: staffA.user!.id,
      startsAt: '2030-08-05T09:00:00.000Z',
      endsAt: '2030-08-05T17:00:00.000Z',
    })).json()).shift;
    const sF = (await (await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Shift Can F',
      assignedToUserId: staffB.user!.id,
      startsAt: '2030-08-06T09:00:00.000Z',
      endsAt: '2030-08-06T17:00:00.000Z',
    })).json()).shift;

    const swap3 = (await (await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: sE.id,
      targetShiftId: sF.id,
    })).json()).shiftSwap;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap3.id}/cancel`, staffA.accessToken);

    const feedRes = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const feed = (await feedRes.json()) as ActivityFeedResponse;
    const types = feed.events!.map((e) => e.type);

    assert.ok(types.includes('SWAP_PEER_DECLINED'), 'feed must include SWAP_PEER_DECLINED');
    assert.ok(types.includes('SWAP_REJECTED'), 'feed must include SWAP_REJECTED');
    assert.ok(types.includes('SWAP_CANCELLED'), 'feed must include SWAP_CANCELLED');
  });

  it('guarantees atomic event persistence: rolled-back mutations do not leave false activity events', async () => {
    const owner = await register('Atomic Test Owner');
    const teamId = await createTeam(owner, 'Atomic Test Team');

    const countBefore = await prisma.activityEvent.count({ where: { teamId } });

    // Intentionally trigger a business logic error (shift duration > 24 hours -> 400)
    const failRes = await jsonRequest(`/teams/${teamId}/shifts`, owner.accessToken, {
      title: 'Invalid Long Shift',
      assignedToUserId: owner.user!.id,
      startsAt: '2030-09-01T08:00:00.000Z',
      endsAt: '2030-09-03T08:00:00.000Z', // 48h > 24h limit
    });
    assert.strictEqual(failRes.status, 400);

    const countAfter = await prisma.activityEvent.count({ where: { teamId } });
    assert.strictEqual(countAfter, countBefore, 'failed mutation must not create any activity event');
  });

  it('navigates keyset pagination across multiple pages and handles identical timestamps deterministically', async () => {
    const owner = await register('Pagination Owner');
    const teamId = await createTeam(owner, 'Pagination Team');

    // Create 5 activity events with the exact same millisecond timestamp
    const fixedTimestamp = new Date('2030-10-15T12:00:00.000Z');
    const eventIds: string[] = [];

    for (let i = 1; i <= 5; i++) {
      const ev = await prisma.activityEvent.create({
        data: {
          teamId,
          actorUserId: owner.user!.id,
          type: ActivityEventType.SHIFT_CREATED,
          entityType: 'SHIFT',
          entityId: randomUUID(),
          metadata: { itemIndex: i },
          createdAt: fixedTimestamp,
        },
      });
      eventIds.push(ev.id);
    }

    // Page 1 with limit=2
    const p1Res = await request(`/teams/${teamId}/activity?limit=2`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(p1Res.status, 200);
    const p1 = (await p1Res.json()) as ActivityFeedResponse;

    assert.strictEqual(p1.events!.length, 2);
    assert.strictEqual(p1.pagination!.hasMore, true);
    assert.ok(p1.pagination!.nextCursor, 'page 1 must provide nextCursor');

    // Page 2 with cursor from Page 1, limit=2
    const p2Res = await request(`/teams/${teamId}/activity?limit=2&cursor=${p1.pagination!.nextCursor}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(p2Res.status, 200);
    const p2 = (await p2Res.json()) as ActivityFeedResponse;

    assert.strictEqual(p2.events!.length, 2);
    assert.strictEqual(p2.pagination!.hasMore, true);
    assert.ok(p2.pagination!.nextCursor, 'page 2 must provide nextCursor');

    // Page 3 with cursor from Page 2, limit=2
    const p3Res = await request(`/teams/${teamId}/activity?limit=2&cursor=${p2.pagination!.nextCursor}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(p3Res.status, 200);
    const p3 = (await p3Res.json()) as ActivityFeedResponse;

    assert.strictEqual(p3.events!.length, 1);
    assert.strictEqual(p3.pagination!.hasMore, false);
    assert.strictEqual(p3.pagination!.nextCursor, null);

    // Verify all 5 items were retrieved with zero duplicates
    const collectedIds = [
      ...p1.events!.map((e) => e.id),
      ...p2.events!.map((e) => e.id),
      ...p3.events!.map((e) => e.id),
    ];
    assert.strictEqual(collectedIds.length, 5);
    const uniqueIds = new Set(collectedIds);
    assert.strictEqual(uniqueIds.size, 5, 'keyset pagination must have zero duplicate items across pages');

    // Verify tie-breaking order: id DESC for identical timestamps
    for (let i = 0; i < collectedIds.length - 1; i++) {
      assert.ok(
        collectedIds[i] > collectedIds[i + 1],
        `Item ${collectedIds[i]} should sort before ${collectedIds[i + 1]} by id DESC`
      );
    }
  });

  it('rejects invalid cursors with HTTP 400 Bad Request', async () => {
    const owner = await register('Cursor Validation Owner');
    const teamId = await createTeam(owner, 'Cursor Validation Team');

    const invalidCursors = [
      'not-base64-json',
      Buffer.from('plain string').toString('base64url'),
      Buffer.from(JSON.stringify({ notDate: 'invalid' })).toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: 'invalid-date', id: 'some-id' })).toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })).toString('base64url'), // missing id
    ];

    for (const badCursor of invalidCursors) {
      const res = await request(`/teams/${teamId}/activity?cursor=${encodeURIComponent(badCursor)}`, {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      assert.strictEqual(res.status, 400, `cursor "${badCursor}" must be rejected with 400`);
    }
  });

  it('enforces tenant isolation: non-members receive HTTP 404 (anti-enumeration)', async () => {
    const owner1 = await register('Tenant Owner 1');
    const owner2 = await register('Tenant Owner 2');
    const teamId1 = await createTeam(owner1, 'Tenant Team 1');

    // Owner 2 tries to read Team 1 activity feed
    const res = await request(`/teams/${teamId1}/activity`, {
      headers: { authorization: `Bearer ${owner2.accessToken}` },
    });
    assert.strictEqual(res.status, 404, 'non-member must receive 404 anti-enumeration response');
  });

  it('enforces authentication: unauthenticated requests receive HTTP 401', async () => {
    const owner = await register('Auth Test Owner');
    const teamId = await createTeam(owner, 'Auth Test Team');

    const res = await request(`/teams/${teamId}/activity`);
    assert.strictEqual(res.status, 401, 'unauthenticated request must return 401');
  });

  it('allows staff members to read team activity feed', async () => {
    const owner = await register('Staff Reader Owner');
    const staff = await register('Staff Reader Staff');
    const teamId = await createTeam(owner, 'Staff Reader Team');

    await jsonRequest(`/teams/${teamId}/members`, owner.accessToken, {
      userId: staff.user!.id,
      role: 'STAFF',
    });

    const res = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${staff.accessToken}` },
    });
    assert.strictEqual(res.status, 200, 'staff member must be permitted to read team activity feed');
  });

  it('ensures sanitized metadata never contains passwords, tokens or secrets', async () => {
    const owner = await register('Secret Audit Owner');
    const teamId = await createTeam(owner, 'Secret Audit Team');

    // Direct creation via service with sensitive keys injected
    await prisma.$transaction(async (tx) => {
      const { activityService } = await import('../services/activity.service');
      await activityService.logEvent(tx, {
        teamId,
        actorUserId: owner.user!.id,
        type: ActivityEventType.MEMBER_ADDED,
        entityType: 'TEST',
        entityId: randomUUID(),
        metadata: {
          allowedKey: 'safe-value',
          password: 'super-secret-password',
          passwordHash: 'bcrypt$hash',
          token: 'jwt.token.here',
          accessToken: 'secret_access_token',
          secret: 'top-secret',
        },
      });
    });

    const feedRes = await request(`/teams/${teamId}/activity`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.strictEqual(feedRes.status, 200);
    const feed = (await feedRes.json()) as ActivityFeedResponse;
    const event = feed.events!.find((e) => e.type === 'MEMBER_ADDED');

    assert.ok(event, 'event must exist');
    assert.strictEqual(event!.metadata?.allowedKey, 'safe-value');
    assert.strictEqual(event!.metadata?.password, undefined, 'password must be stripped');
    assert.strictEqual(event!.metadata?.passwordHash, undefined, 'passwordHash must be stripped');
    assert.strictEqual(event!.metadata?.token, undefined, 'token must be stripped');
    assert.strictEqual(event!.metadata?.accessToken, undefined, 'accessToken must be stripped');
    assert.strictEqual(event!.metadata?.secret, undefined, 'secret must be stripped');
  });
});
