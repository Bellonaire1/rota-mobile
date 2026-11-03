import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';

interface AuthResponse {
  user?: { id: string; email: string; name: string | null };
  accessToken?: string;
}

interface TeamResponse {
  team?: { id: string };
}

interface ShiftResponse {
  shift?: {
    id: string;
    teamId: string;
    assignedToUserId: string;
    status: string;
    startsAt: string;
    endsAt: string;
    title: string;
    updatedAt: string;
  };
}

interface ShiftSwapResponse {
  shiftSwap?: {
    id: string;
    teamId: string;
    sourceShiftId: string;
    targetShiftId: string;
    requestingUserId: string;
    receivingUserId: string;
    status: string;
    peerRespondedAt?: string | null;
    reviewedByUserId?: string | null;
    reviewedAt?: string | null;
    rejectionReason?: string | null;
    sourceShift?: {
      id: string;
      title: string;
      assignedToUserId: string;
    };
    targetShift?: {
      id: string;
      title: string;
      assignedToUserId: string;
    };
  };
  shiftSwaps?: Array<{
    id: string;
    status: string;
    requestingUserId: string;
    receivingUserId: string;
  }>;
  pagination?: {
    total: number;
    totalPages: number;
    page: number;
    limit: number;
  };
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, options);

const register = async (name = 'Shift Swap User'): Promise<AuthResponse> => {
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `swap-test-${randomUUID()}@example.com`,
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

const createTeam = async (auth: AuthResponse, name = 'Shift Swap Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const addMember = (teamId: string, owner: AuthResponse, userId: string, role = 'STAFF') =>
  jsonRequest(`/teams/${teamId}/members`, owner.accessToken, { userId, role });

const createShift = async (
  teamId: string,
  managerAuth: AuthResponse,
  assignedToUserId: string,
  startsAt = '2030-05-01T09:00:00.000Z',
  endsAt = '2030-05-01T17:00:00.000Z',
  title = 'Standard Shift'
) => {
  const response = await jsonRequest(`/teams/${teamId}/shifts`, managerAuth.accessToken, {
    title,
    assignedToUserId,
    startsAt,
    endsAt,
  });
  const body = (await response.json()) as ShiftResponse;
  return body.shift!;
};

const skipReason = authIntegrationSkipReason();

describe('shift swap API', { concurrency: false, skip: skipReason }, () => {
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
      await prisma.shiftSwapRequest.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamMembership.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.shift.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('validates swap request submission, enforces shift ownership, and prevents self or invalid shifts', async () => {
    const owner = await register('Team Owner');
    const staffA = await register('Staff Alice');
    const staffB = await register('Staff Bob');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-01T09:00:00.000Z', '2030-05-01T17:00:00.000Z', 'Shift A');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-02T09:00:00.000Z', '2030-05-02T17:00:00.000Z', 'Shift B');

    // 1. Staff B tries to swap Shift A (owned by Staff A) -> 403 Forbidden
    const nonOwnerRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffB.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    assert.equal(nonOwnerRes.status, 403);

    // 2. Self swap (same shift) -> 400 Bad Request
    const selfSwapRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftA.id,
    });
    assert.equal(selfSwapRes.status, 400);

    // 3. Self swap (different shifts owned by same user)
    const shiftA2 = await createShift(teamId, owner, staffA.user!.id, '2030-05-03T09:00:00.000Z', '2030-05-03T17:00:00.000Z', 'Shift A2');
    const selfDifferentShiftRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftA2.id,
    });
    assert.equal(selfDifferentShiftRes.status, 400);

    // 4. Foreign team shift
    const foreignTeamId = await createTeam(owner, 'Foreign Team');
    const foreignShift = await createShift(foreignTeamId, owner, owner.user!.id, '2030-05-01T09:00:00.000Z', '2030-05-01T17:00:00.000Z', 'Foreign Shift');
    const foreignRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: foreignShift.id,
    });
    assert.equal(foreignRes.status, 404);

    // 5. Valid swap request submission
    const validRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    assert.equal(validRes.status, 201);
    const validBody = (await validRes.json()) as ShiftSwapResponse;
    assert.equal(validBody.shiftSwap?.status, 'PENDING_PEER');
    assert.equal(validBody.shiftSwap?.requestingUserId, staffA.user!.id);
    assert.equal(validBody.shiftSwap?.receivingUserId, staffB.user!.id);
    assert.equal(validBody.shiftSwap?.sourceShiftId, shiftA.id);
    assert.equal(validBody.shiftSwap?.targetShiftId, shiftB.id);
  });

  it('rejects duplicate or conflicting active requests involving either shift', async () => {
    const owner = await register('Team Owner 2');
    const staffA = await register('Staff Alice 2');
    const staffB = await register('Staff Bob 2');
    const staffC = await register('Staff Charlie 2');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');
    await addMember(teamId, owner, staffC.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-10T09:00:00.000Z', '2030-05-10T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-11T09:00:00.000Z', '2030-05-11T17:00:00.000Z');
    const shiftC = await createShift(teamId, owner, staffC.user!.id, '2030-05-12T09:00:00.000Z', '2030-05-12T17:00:00.000Z');

    // Create initial swap for shiftA <-> shiftB
    const res1 = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    assert.equal(res1.status, 201);

    // Attempt to create another swap involving shiftA
    const res2 = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftC.id,
    });
    assert.equal(res2.status, 409);

    // Attempt to create another swap involving shiftB as target
    const res3 = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffC.accessToken, {
      sourceShiftId: shiftC.id,
      targetShiftId: shiftB.id,
    });
    assert.equal(res3.status, 409);
  });

  it('atomically prevents concurrent creation of conflicting swap requests sharing source or target shifts', async () => {
    const owner = await register('Team Owner Concurrency');
    const staffA = await register('Staff Alice Concurrency');
    const staffB = await register('Staff Bob Concurrency');
    const staffC = await register('Staff Charlie Concurrency');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');
    await addMember(teamId, owner, staffC.user!.id, 'STAFF');

    // --- Scenario 1: Same source shift, competing targets ---
    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-13T09:00:00.000Z', '2030-05-13T17:00:00.000Z', 'Alice Shift');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-14T09:00:00.000Z', '2030-05-14T17:00:00.000Z', 'Bob Shift');
    const shiftC = await createShift(teamId, owner, staffC.user!.id, '2030-05-15T09:00:00.000Z', '2030-05-15T17:00:00.000Z', 'Charlie Shift');

    // Alice concurrently proposes Shift A <-> Shift B AND Shift A <-> Shift C
    const [resSameSource1, resSameSource2] = await Promise.all([
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
        sourceShiftId: shiftA.id,
        targetShiftId: shiftB.id,
      }),
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
        sourceShiftId: shiftA.id,
        targetShiftId: shiftC.id,
      }),
    ]);

    const sameSourceStatuses = [resSameSource1.status, resSameSource2.status].sort();
    assert.deepEqual(
      sameSourceStatuses,
      [201, 409],
      'Concurrent creation sharing the same source shift must have exactly one 201 winner and one 409 conflict'
    );

    // Verify exactly one active swap exists in DB for Shift A
    const activeSwapsShiftA = await prisma.shiftSwapRequest.findMany({
      where: {
        teamId,
        OR: [{ sourceShiftId: shiftA.id }, { targetShiftId: shiftA.id }],
        status: { in: ['PENDING_PEER', 'PENDING_MANAGER'] },
      },
    });
    assert.equal(activeSwapsShiftA.length, 1);

    // Shift assignments must remain unchanged
    const currentA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    assert.equal(currentA?.assignedToUserId, staffA.user!.id);

    // --- Scenario 2: Same target shift, competing sources ---
    const staffD = await register('Staff Dave Concurrency');
    const staffE = await register('Staff Emma Concurrency');
    const staffF = await register('Staff Frank Concurrency');
    await addMember(teamId, owner, staffD.user!.id, 'STAFF');
    await addMember(teamId, owner, staffE.user!.id, 'STAFF');
    await addMember(teamId, owner, staffF.user!.id, 'STAFF');

    const shiftD = await createShift(teamId, owner, staffD.user!.id, '2030-05-16T09:00:00.000Z', '2030-05-16T17:00:00.000Z', 'Dave Shift');
    const shiftE = await createShift(teamId, owner, staffE.user!.id, '2030-05-17T09:00:00.000Z', '2030-05-17T17:00:00.000Z', 'Emma Shift');
    const shiftF = await createShift(teamId, owner, staffF.user!.id, '2030-05-18T09:00:00.000Z', '2030-05-18T17:00:00.000Z', 'Frank Target Shift');

    // Dave proposes Shift D <-> Shift F concurrently with Emma proposing Shift E <-> Shift F
    const [resSameTarget1, resSameTarget2] = await Promise.all([
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffD.accessToken, {
        sourceShiftId: shiftD.id,
        targetShiftId: shiftF.id,
      }),
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffE.accessToken, {
        sourceShiftId: shiftE.id,
        targetShiftId: shiftF.id,
      }),
    ]);

    const sameTargetStatuses = [resSameTarget1.status, resSameTarget2.status].sort();
    assert.deepEqual(
      sameTargetStatuses,
      [201, 409],
      'Concurrent creation sharing the same target shift must have exactly one 201 winner and one 409 conflict'
    );

    const activeSwapsShiftF = await prisma.shiftSwapRequest.findMany({
      where: {
        teamId,
        OR: [{ sourceShiftId: shiftF.id }, { targetShiftId: shiftF.id }],
        status: { in: ['PENDING_PEER', 'PENDING_MANAGER'] },
      },
    });
    assert.equal(activeSwapsShiftF.length, 1);

    // --- Scenario 3: Mixed role — same shift as source in req 1 and target in req 2 ---
    const staffG = await register('Staff Grace Concurrency');
    const staffH = await register('Staff Henry Concurrency');
    const staffJ = await register('Staff Jack Concurrency');
    await addMember(teamId, owner, staffG.user!.id, 'STAFF');
    await addMember(teamId, owner, staffH.user!.id, 'STAFF');
    await addMember(teamId, owner, staffJ.user!.id, 'STAFF');

    const shiftG = await createShift(teamId, owner, staffG.user!.id, '2030-05-19T09:00:00.000Z', '2030-05-19T17:00:00.000Z', 'Grace Shift');
    const shiftH = await createShift(teamId, owner, staffH.user!.id, '2030-05-20T09:00:00.000Z', '2030-05-20T17:00:00.000Z', 'Henry Shift');
    const shiftJ = await createShift(teamId, owner, staffJ.user!.id, '2030-05-21T09:00:00.000Z', '2030-05-21T17:00:00.000Z', 'Jack Shift');

    // Grace proposes Shift G <-> Shift H (Henry is target)
    // Concurrently, Henry proposes Shift H <-> Shift J (Henry is source)
    const [resMixed1, resMixed2] = await Promise.all([
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffG.accessToken, {
        sourceShiftId: shiftG.id,
        targetShiftId: shiftH.id,
      }),
      jsonRequest(`/teams/${teamId}/shift-swaps`, staffH.accessToken, {
        sourceShiftId: shiftH.id,
        targetShiftId: shiftJ.id,
      }),
    ]);

    const mixedStatuses = [resMixed1.status, resMixed2.status].sort();
    assert.deepEqual(
      mixedStatuses,
      [201, 409],
      'Concurrent creation sharing a shift across source and target roles must have exactly one 201 winner and one 409 conflict'
    );

    const activeSwapsShiftH = await prisma.shiftSwapRequest.findMany({
      where: {
        teamId,
        OR: [{ sourceShiftId: shiftH.id }, { targetShiftId: shiftH.id }],
        status: { in: ['PENDING_PEER', 'PENDING_MANAGER'] },
      },
    });
    assert.equal(activeSwapsShiftH.length, 1);
  });

  it('enforces recipient response rules: wrong recipient denied, decline ends workflow', async () => {
    const owner = await register('Team Owner 3');
    const staffA = await register('Staff Alice 3');
    const staffB = await register('Staff Bob 3');
    const staffC = await register('Staff Charlie 3');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');
    await addMember(teamId, owner, staffC.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-15T09:00:00.000Z', '2030-05-15T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-16T09:00:00.000Z', '2030-05-16T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    // Wrong recipient (Staff C) tries to respond -> 403 Forbidden
    const wrongUserRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffC.accessToken, {
      action: 'accept',
    });
    assert.equal(wrongUserRes.status, 403);

    // Requester (Staff A) tries to respond to own request -> 403 Forbidden
    const requesterRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffA.accessToken, {
      action: 'accept',
    });
    assert.equal(requesterRes.status, 403);

    // Intended recipient declines
    const declineRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'decline',
    });
    assert.equal(declineRes.status, 200);
    const declineBody = (await declineRes.json()) as ShiftSwapResponse;
    assert.equal(declineBody.shiftSwap?.status, 'DECLINED');
    assert.ok(declineBody.shiftSwap?.peerRespondedAt);

    // Cannot respond again after decline -> 409 Conflict
    const secondRespondRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });
    assert.equal(secondRespondRes.status, 409);

    // Manager cannot approve a declined swap -> 409 Conflict
    const reviewDeclinedRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(reviewDeclinedRes.status, 409);
  });

  it('prevents manager review before peer acceptance and denies staff approval permission', async () => {
    const owner = await register('Team Owner 4');
    const staffA = await register('Staff Alice 4');
    const staffB = await register('Staff Bob 4');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-20T09:00:00.000Z', '2030-05-20T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-21T09:00:00.000Z', '2030-05-21T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    // Manager attempts to approve before peer responds -> 409 Conflict
    const prematureReviewRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(prematureReviewRes.status, 409);

    // Peer accepts
    const acceptRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });
    assert.equal(acceptRes.status, 200);
    const acceptedSwap = ((await acceptRes.json()) as ShiftSwapResponse).shiftSwap!;
    assert.equal(acceptedSwap.status, 'PENDING_MANAGER');

    // Staff member attempts to review/approve -> 403 Forbidden
    const staffReviewRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, staffA.accessToken, {
      action: 'approve',
    });
    assert.equal(staffReviewRes.status, 403);
  });

  it('records manager rejection with optional reason and keeps shift assignments unchanged', async () => {
    const owner = await register('Team Owner 5');
    const staffA = await register('Staff Alice 5');
    const staffB = await register('Staff Bob 5');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-05-25T09:00:00.000Z', '2030-05-25T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-05-26T09:00:00.000Z', '2030-05-26T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Manager rejects with reason
    const rejectRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'reject',
      reason: 'Understaffed during holiday coverage',
    });
    assert.equal(rejectRes.status, 200);
    const rejectedBody = (await rejectRes.json()) as ShiftSwapResponse;
    assert.equal(rejectedBody.shiftSwap?.status, 'REJECTED');
    assert.equal(rejectedBody.shiftSwap?.reviewedByUserId, owner.user!.id);
    assert.equal(rejectedBody.shiftSwap?.rejectionReason, 'Understaffed during holiday coverage');
    assert.ok(rejectedBody.shiftSwap?.reviewedAt);

    // Shifts remain unchanged
    const currentShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const currentShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(currentShiftA?.assignedToUserId, staffA.user!.id);
    assert.equal(currentShiftB?.assignedToUserId, staffB.user!.id);
  });

  it('performs atomic exchange on approval: no changes prior, exact atomic swap after', async () => {
    const owner = await register('Team Owner 6');
    const staffA = await register('Staff Alice 6');
    const staffB = await register('Staff Bob 6');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-06-01T09:00:00.000Z', '2030-06-01T17:00:00.000Z', 'Alice Morning');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-06-02T09:00:00.000Z', '2030-06-02T17:00:00.000Z', 'Bob Morning');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    // Check assignments are unchanged before approval
    const preShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const preShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(preShiftA?.assignedToUserId, staffA.user!.id);
    assert.equal(preShiftB?.assignedToUserId, staffB.user!.id);

    // Peer accepts
    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Check assignments still unchanged after peer acceptance
    const midShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const midShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(midShiftA?.assignedToUserId, staffA.user!.id);
    assert.equal(midShiftB?.assignedToUserId, staffB.user!.id);

    // Manager approves
    const approveRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(approveRes.status, 200);
    const approveBody = (await approveRes.json()) as ShiftSwapResponse;
    assert.equal(approveBody.shiftSwap?.status, 'APPROVED');
    assert.equal(approveBody.shiftSwap?.reviewedByUserId, owner.user!.id);
    assert.ok(approveBody.shiftSwap?.reviewedAt);

    // Verify atomic swap completed
    const postShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const postShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(postShiftA?.assignedToUserId, staffB.user!.id);
    assert.equal(postShiftB?.assignedToUserId, staffA.user!.id);
  });

  it('rejects approval when resulting assignment creates a schedule overlap for either staff member', async () => {
    const owner = await register('Team Owner 7');
    const staffA = await register('Staff Alice 7');
    const staffB = await register('Staff Bob 7');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    // Shift A: 2030-06-10 09:00 - 17:00
    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-06-10T09:00:00.000Z', '2030-06-10T17:00:00.000Z');
    // Shift B: 2030-06-11 09:00 - 17:00
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-06-11T09:00:00.000Z', '2030-06-11T17:00:00.000Z');
    // Existing other shift for Staff A that overlaps Shift B (2030-06-11 12:00 - 20:00)
    await createShift(teamId, owner, staffA.user!.id, '2030-06-11T12:00:00.000Z', '2030-06-11T20:00:00.000Z', 'Overlap Conflicting Shift');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Approval must fail due to overlap on Staff A
    const approveRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(approveRes.status, 409);

    // Shifts remain unchanged
    const currentShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const currentShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(currentShiftA?.assignedToUserId, staffA.user!.id);
    assert.equal(currentShiftB?.assignedToUserId, staffB.user!.id);
  });

  it('rejects approval when a shift has been cancelled after the swap request was created', async () => {
    const owner = await register('Team Owner 8');
    const staffA = await register('Staff Alice 8');
    const staffB = await register('Staff Bob 8');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-06-15T09:00:00.000Z', '2030-06-15T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-06-16T09:00:00.000Z', '2030-06-16T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Manager cancels Shift A before reviewing swap
    const cancelShiftRes = await jsonRequest(`/teams/${teamId}/shifts/${shiftA.id}/cancel`, owner.accessToken, {
      updatedAt: shiftA.updatedAt,
    });
    assert.equal(cancelShiftRes.status, 200);

    // Manager attempts to approve swap -> 409 Conflict
    const approveRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(approveRes.status, 409);
  });

  it('rejects approval when a shift has been modified or reassigned after the request was created', async () => {
    const owner = await register('Team Owner 9');
    const staffA = await register('Staff Alice 9');
    const staffB = await register('Staff Bob 9');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-06-20T09:00:00.000Z', '2030-06-20T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-06-21T09:00:00.000Z', '2030-06-21T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Manager updates Shift B time
    const updateRes = await jsonRequest(`/teams/${teamId}/shifts/${shiftB.id}`, owner.accessToken, {
      startsAt: '2030-06-21T10:00:00.000Z',
      endsAt: '2030-06-21T18:00:00.000Z',
      updatedAt: shiftB.updatedAt,
    }, 'PATCH');
    assert.equal(updateRes.status, 200);

    // Approval fails due to stale schedule snapshot
    const approveRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, {
      action: 'approve',
    });
    assert.equal(approveRes.status, 409);
  });

  it('handles concurrent approvals safely with single-winner behavior', async () => {
    const owner = await register('Team Owner 10');
    const manager = await register('Team Manager 10');
    const staffA = await register('Staff Alice 10');
    const staffB = await register('Staff Bob 10');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-07-01T09:00:00.000Z', '2030-07-01T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-07-02T09:00:00.000Z', '2030-07-02T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/respond`, staffB.accessToken, {
      action: 'accept',
    });

    // Launch 2 simultaneous approvals (one by Owner, one by Manager)
    const [resOwner, resManager] = await Promise.all([
      jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, owner.accessToken, { action: 'approve' }),
      jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/review`, manager.accessToken, { action: 'approve' }),
    ]);

    const statuses = [resOwner.status, resManager.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Exactly one approval succeeds with 200, the other fails with 409');

    // Verify swap is approved and shifts swapped exactly once
    const finalShiftA = await prisma.shift.findUnique({ where: { id: shiftA.id } });
    const finalShiftB = await prisma.shift.findUnique({ where: { id: shiftB.id } });
    assert.equal(finalShiftA?.assignedToUserId, staffB.user!.id);
    assert.equal(finalShiftB?.assignedToUserId, staffA.user!.id);
  });

  it('allows requester to cancel unresolved request, denies non-requester cancellation, and rejects cancelling resolved request', async () => {
    const owner = await register('Team Owner 11');
    const staffA = await register('Staff Alice 11');
    const staffB = await register('Staff Bob 11');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');

    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-07-10T09:00:00.000Z', '2030-07-10T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-07-11T09:00:00.000Z', '2030-07-11T17:00:00.000Z');

    const createRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    const swap = ((await createRes.json()) as ShiftSwapResponse).shiftSwap!;

    // Staff B attempts to cancel Staff A's request -> 403 Forbidden
    const nonRequesterRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/cancel`, staffB.accessToken);
    assert.equal(nonRequesterRes.status, 403);

    // Requester cancels
    const cancelRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/cancel`, staffA.accessToken);
    assert.equal(cancelRes.status, 200);
    const cancelBody = (await cancelRes.json()) as ShiftSwapResponse;
    assert.equal(cancelBody.shiftSwap?.status, 'CANCELLED');

    // Attempting to cancel again -> 409 Conflict
    const reCancelRes = await jsonRequest(`/teams/${teamId}/shift-swaps/${swap.id}/cancel`, staffA.accessToken);
    assert.equal(reCancelRes.status, 409);
  });

  it('supports listing with status filtering, pagination, and staff privacy filtering', async () => {
    const owner = await register('Team Owner 12');
    const staffA = await register('Staff Alice 12');
    const staffB = await register('Staff Bob 12');
    const staffC = await register('Staff Charlie 12');
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staffA.user!.id, 'STAFF');
    await addMember(teamId, owner, staffB.user!.id, 'STAFF');
    await addMember(teamId, owner, staffC.user!.id, 'STAFF');

    // Create shifts
    const shiftA = await createShift(teamId, owner, staffA.user!.id, '2030-08-01T09:00:00.000Z', '2030-08-01T17:00:00.000Z');
    const shiftB = await createShift(teamId, owner, staffB.user!.id, '2030-08-02T09:00:00.000Z', '2030-08-02T17:00:00.000Z');
    const shiftC = await createShift(teamId, owner, staffC.user!.id, '2030-08-03T09:00:00.000Z', '2030-08-03T17:00:00.000Z');
    const shiftA2 = await createShift(teamId, owner, staffA.user!.id, '2030-08-04T09:00:00.000Z', '2030-08-04T17:00:00.000Z');

    // Swap 1: Alice <-> Bob
    const swap1Res = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA.id,
      targetShiftId: shiftB.id,
    });
    assert.equal(swap1Res.status, 201);

    // Swap 2: Alice <-> Charlie
    const swap2Res = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffA.accessToken, {
      sourceShiftId: shiftA2.id,
      targetShiftId: shiftC.id,
    });
    assert.equal(swap2Res.status, 201);

    // Charlie sees only Swap 2 (not Swap 1)
    const charlieListRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, staffC.accessToken, undefined, 'GET');
    assert.equal(charlieListRes.status, 200);
    const charlieBody = (await charlieListRes.json()) as ShiftSwapResponse;
    assert.equal(charlieBody.shiftSwaps?.length, 1);
    assert.equal(charlieBody.shiftSwaps![0].receivingUserId, staffC.user!.id);

    // Owner sees both swaps
    const ownerListRes = await jsonRequest(`/teams/${teamId}/shift-swaps`, owner.accessToken, undefined, 'GET');
    assert.equal(ownerListRes.status, 200);
    const ownerBody = (await ownerListRes.json()) as ShiftSwapResponse;
    assert.equal(ownerBody.shiftSwaps?.length, 2);

    // Pagination test
    const pageRes = await jsonRequest(`/teams/${teamId}/shift-swaps?page=1&limit=1`, owner.accessToken, undefined, 'GET');
    assert.equal(pageRes.status, 200);
    const pageBody = (await pageRes.json()) as ShiftSwapResponse;
    assert.equal(pageBody.shiftSwaps?.length, 1);
    assert.equal(pageBody.pagination?.total, 2);
    assert.equal(pageBody.pagination?.totalPages, 2);
  });

  it('maintains foreign-team 404 anti-enumeration isolation for all endpoints', async () => {
    const owner1 = await register('Owner Team 1');
    const owner2 = await register('Owner Team 2');
    const team1Id = await createTeam(owner1, 'Team 1');
    const team2Id = await createTeam(owner2, 'Team 2');

    // Owner 2 attempts to list shift swaps on Team 1 -> 404
    const listRes = await jsonRequest(`/teams/${team1Id}/shift-swaps`, owner2.accessToken, undefined, 'GET');
    assert.equal(listRes.status, 404);

    // Owner 2 attempts to create shift swap on Team 1 -> 404
    const fakeId = randomUUID();
    const fakeShiftId1 = randomUUID();
    const fakeShiftId2 = randomUUID();
    const createRes = await jsonRequest(`/teams/${team1Id}/shift-swaps`, owner2.accessToken, {
      sourceShiftId: fakeShiftId1,
      targetShiftId: fakeShiftId2,
    });
    assert.equal(createRes.status, 404);

    // Owner 2 attempts to respond to non-member team swap -> 404
    const respondRes = await jsonRequest(`/teams/${team1Id}/shift-swaps/${fakeId}/respond`, owner2.accessToken, {
      action: 'accept',
    });
    assert.equal(respondRes.status, 404);

    // Owner 2 attempts to review non-member team swap -> 404
    const reviewRes = await jsonRequest(`/teams/${team1Id}/shift-swaps/${fakeId}/review`, owner2.accessToken, {
      action: 'approve',
    });
    assert.equal(reviewRes.status, 404);

    // Owner 2 attempts to cancel non-member team swap -> 404
    const cancelRes = await jsonRequest(`/teams/${team1Id}/shift-swaps/${fakeId}/cancel`, owner2.accessToken);
    assert.equal(cancelRes.status, 404);
  });
});

