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
    createdByUserId?: string;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    status: string;
    cancelledAt?: string | null;
    cancelledByUserId?: string | null;
    updatedAt: string;
    assignedTo?: { id: string; email: string; name: string | null };
    createdBy?: { id: string; email: string; name: string | null };
  };
  shifts?: Array<{
    id: string;
    status: string;
    startsAt?: string;
    endsAt?: string;
    assignedToUserId?: string;
  }>;
  pagination?: { total: number; totalPages: number; page?: number; limit?: number };
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, options);

const register = async (): Promise<AuthResponse> => {
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `shift-test-${randomUUID()}@example.com`,
      name: 'Shift Test User',
      password: 'correct horse battery staple',
    }),
  });
  const body = (await response.json()) as AuthResponse;
  createdUserIds.push(body.user!.id);
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

const createTeam = async (auth: AuthResponse, name = 'Shift Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const addMember = (teamId: string, owner: AuthResponse, userId: string, role = 'STAFF') =>
  jsonRequest(`/teams/${teamId}/members`, owner.accessToken, { userId, role });

const createShift = (
  teamId: string,
  auth: AuthResponse,
  assignedToUserId: string,
  startsAt = '2030-01-01T09:00:00.000Z',
  endsAt = '2030-01-01T17:00:00.000Z'
) =>
  jsonRequest(`/teams/${teamId}/shifts`, auth.accessToken, {
    title: 'Morning shift',
    assignedToUserId,
    startsAt,
    endsAt,
  });

const skipReason = authIntegrationSkipReason();

describe('shift scheduling API', { concurrency: false, skip: skipReason }, () => {
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

  it('requires authentication and validates timestamp rules', async () => {
    const teamId = randomUUID();
    const unauthenticated = await createShift(teamId, {}, randomUUID());
    const owner = await register();
    const assignee = await register();
    const realTeamId = await createTeam(owner);
    await addMember(realTeamId, owner, assignee.user!.id);
    const missingOffset = await createShift(
      realTeamId,
      owner,
      assignee.user!.id,
      '2030-01-01T09:00:00',
      '2030-01-01T10:00:00Z'
    );
    const tooLong = await createShift(
      realTeamId,
      owner,
      assignee.user!.id,
      '2030-01-01T09:00:00Z',
      '2030-01-02T10:00:00Z'
    );

    assert.equal(unauthenticated.status, 401);
    assert.equal(missingOffset.status, 400);
    assert.equal(tooLong.status, 400);
  });

  it('allows OWNER and MANAGER mutations while STAFF can only list', async () => {
    const owner = await register();
    const manager = await register();
    const staff = await register();
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');
    await addMember(teamId, owner, staff.user!.id);

    const ownerCreate = await createShift(teamId, owner, staff.user!.id);
    const managerCreate = await createShift(
      teamId,
      manager,
      manager.user!.id,
      '2030-01-02T09:00:00Z',
      '2030-01-02T17:00:00Z'
    );
    const staffList = await request(`/teams/${teamId}/shifts`, {
      headers: { authorization: `Bearer ${staff.accessToken}` },
    });
    const staffCreate = await createShift(
      teamId,
      staff,
      staff.user!.id,
      '2030-01-03T09:00:00Z',
      '2030-01-03T17:00:00Z'
    );

    assert.equal(ownerCreate.status, 201);
    assert.equal(managerCreate.status, 201);
    assert.equal(staffList.status, 200);
    assert.equal(staffCreate.status, 403);
  });

  it('enforces current-team assignment, cross-team isolation, and overlap prevention', async () => {
    const owner = await register();
    const otherOwner = await register();
    const assignee = await register();
    const teamId = await createTeam(owner, 'First Shift Team');
    const otherTeamId = await createTeam(otherOwner, 'Second Shift Team');
    await addMember(teamId, owner, assignee.user!.id);
    await addMember(otherTeamId, otherOwner, assignee.user!.id);

    const first = await createShift(teamId, owner, assignee.user!.id);
    const overlapAcrossTeams = await createShift(otherTeamId, otherOwner, assignee.user!.id);
    const nonMember = await createShift(teamId, owner, otherOwner.user!.id, '2030-01-04T09:00:00Z', '2030-01-04T17:00:00Z');
    const crossTeamList = await request(`/teams/${otherTeamId}/shifts`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    assert.equal(first.status, 201);
    assert.equal(overlapAcrossTeams.status, 409);
    assert.equal(nonMember.status, 404);
    assert.equal(crossTeamList.status, 404);
  });

  it('supports cancellation, status filters, pagination, and stale-update protection', async () => {
    const owner = await register();
    const staff = await register();
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, staff.user!.id);
    const created = await createShift(teamId, owner, staff.user!.id);
    const body = (await created.json()) as ShiftResponse;
    const staleUpdate = await jsonRequest(
      `/teams/${teamId}/shifts/${body.shift!.id}`,
      owner.accessToken,
      { title: 'Updated shift', updatedAt: '2029-01-01T00:00:00.000Z' },
      'PATCH'
    );
    const blockedRemoval = await jsonRequest(
      `/teams/${teamId}/members/${staff.user!.id}`,
      owner.accessToken,
      undefined,
      'DELETE'
    );
    const cancelled = await jsonRequest(
      `/teams/${teamId}/shifts/${body.shift!.id}/cancel`,
      owner.accessToken,
      { updatedAt: body.shift!.updatedAt }
    );
    const allowedRemoval = await jsonRequest(
      `/teams/${teamId}/members/${staff.user!.id}`,
      owner.accessToken,
      undefined,
      'DELETE'
    );
    const cancelledList = await request(`/teams/${teamId}/shifts?status=CANCELLED&limit=1`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const scheduledList = await request(`/teams/${teamId}/shifts?status=SCHEDULED`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const cancelledBody = (await cancelledList.json()) as ShiftResponse;
    const scheduledBody = (await scheduledList.json()) as ShiftResponse;

    assert.equal(staleUpdate.status, 409);
    assert.equal(blockedRemoval.status, 409);
    assert.equal(cancelled.status, 200);
    assert.equal(allowedRemoval.status, 204);
    assert.equal((cancelledBody.shifts ?? []).length, 1);
    assert.equal(cancelledBody.pagination?.total, 1);
    assert.equal(scheduledBody.pagination?.total, 0);
  });

  it('allows one concurrent overlapping creation and rejects the other', async () => {
    const owner = await register();
    const assignee = await register();
    const teamId = await createTeam(owner);
    await addMember(teamId, owner, assignee.user!.id);
    const responses = await Promise.all([
      createShift(teamId, owner, assignee.user!.id, '2030-02-01T09:00:00Z', '2030-02-01T17:00:00Z'),
      createShift(teamId, owner, assignee.user!.id, '2030-02-01T09:00:00Z', '2030-02-01T17:00:00Z'),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  });

  it('R03.5: automated authorization denial: staff cannot perform shift mutations or access billing, and foreign-team access is denied', async () => {
    const owner = await register();
    const manager = await register();
    const staff = await register();
    const foreignUser = await register();

    const teamId = await createTeam(owner, 'R03.5 Team');
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');
    await addMember(teamId, owner, staff.user!.id, 'STAFF');

    // Create a shift as owner to test mutations on
    const shiftRes = await createShift(
      teamId,
      owner,
      staff.user!.id,
      '2030-03-01T09:00:00Z',
      '2030-03-01T17:00:00Z'
    );
    assert.equal(shiftRes.status, 201);
    const shiftBody = (await shiftRes.json()) as ShiftResponse;
    const shiftId = shiftBody.shift!.id;
    const shiftUpdatedAt = shiftBody.shift!.updatedAt;

    // 1. Staff cannot perform shift mutations (POST, PATCH, cancel) -> HTTP 403
    const staffCreate = await createShift(
      teamId,
      staff,
      staff.user!.id,
      '2030-03-02T09:00:00Z',
      '2030-03-02T17:00:00Z'
    );
    assert.equal(staffCreate.status, 403);
    const staffCreateBody = (await staffCreate.json()) as { message: string };
    assert.equal(staffCreateBody.message, 'Insufficient team permissions');

    const staffUpdate = await jsonRequest(
      `/teams/${teamId}/shifts/${shiftId}`,
      staff.accessToken,
      { title: 'Staff Hacked Title', updatedAt: shiftUpdatedAt },
      'PATCH'
    );
    assert.equal(staffUpdate.status, 403);
    const staffUpdateBody = (await staffUpdate.json()) as { message: string };
    assert.equal(staffUpdateBody.message, 'Insufficient team permissions');

    const staffCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shiftId}/cancel`,
      staff.accessToken,
      { updatedAt: shiftUpdatedAt }
    );
    assert.equal(staffCancel.status, 403);
    const staffCancelBody = (await staffCancel.json()) as { message: string };
    assert.equal(staffCancelBody.message, 'Insufficient team permissions');

    // 2. Staff cannot access billing endpoints -> HTTP 403
    const staffBillingGet = await request(`/teams/${teamId}/billing`, {
      headers: { authorization: `Bearer ${staff.accessToken}` },
    });
    assert.equal(staffBillingGet.status, 403);
    const staffBillingBody = (await staffBillingGet.json()) as { message: string };
    assert.equal(staffBillingBody.message, 'Insufficient team permissions');

    const staffCheckout = await jsonRequest(
      `/teams/${teamId}/billing/checkout`,
      staff.accessToken,
      { planCode: 'TEAM' }
    );
    assert.equal(staffCheckout.status, 403);
    const staffCheckoutBody = (await staffCheckout.json()) as { message: string };
    assert.equal(staffCheckoutBody.message, 'Insufficient team permissions');

    // 3. Foreign team (non-member) cannot read or write data -> HTTP 404
    const foreignList = await request(`/teams/${teamId}/shifts`, {
      headers: { authorization: `Bearer ${foreignUser.accessToken}` },
    });
    assert.equal(foreignList.status, 404);

    const foreignCreate = await createShift(
      teamId,
      foreignUser,
      foreignUser.user!.id,
      '2030-03-03T09:00:00Z',
      '2030-03-03T17:00:00Z'
    );
    assert.equal(foreignCreate.status, 404);

    const foreignUpdate = await jsonRequest(
      `/teams/${teamId}/shifts/${shiftId}`,
      foreignUser.accessToken,
      { title: 'Foreign update', updatedAt: shiftUpdatedAt },
      'PATCH'
    );
    assert.equal(foreignUpdate.status, 404);

    const foreignCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shiftId}/cancel`,
      foreignUser.accessToken,
      { updatedAt: shiftUpdatedAt }
    );
    assert.equal(foreignCancel.status, 404);

    const foreignBilling = await request(`/teams/${teamId}/billing`, {
      headers: { authorization: `Bearer ${foreignUser.accessToken}` },
    });
    assert.equal(foreignBilling.status, 404);
  });

  it('R04.1: owner and manager shift creation, scheduling, date filtering, and reassignment', async () => {
    const owner = await register();
    const manager = await register();
    const staff1 = await register();
    const staff2 = await register();

    const teamId = await createTeam(owner, 'R04.1 Team');
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');
    await addMember(teamId, owner, staff1.user!.id, 'STAFF');
    await addMember(teamId, owner, staff2.user!.id, 'STAFF');

    // 1. Owner and Manager shift creation & scheduling
    const ownerShiftRes = await createShift(
      teamId,
      owner,
      staff1.user!.id,
      '2030-05-01T08:00:00.000Z',
      '2030-05-01T16:00:00.000Z'
    );
    assert.equal(ownerShiftRes.status, 201);
    const ownerShiftBody = (await ownerShiftRes.json()) as ShiftResponse;
    assert.equal(ownerShiftBody.shift?.assignedToUserId, staff1.user!.id);
    assert.equal(ownerShiftBody.shift?.createdByUserId, owner.user!.id);

    const managerShiftRes = await createShift(
      teamId,
      manager,
      staff2.user!.id,
      '2030-05-15T09:00:00.000Z',
      '2030-05-15T17:00:00.000Z'
    );
    assert.equal(managerShiftRes.status, 201);
    const managerShiftBody = (await managerShiftRes.json()) as ShiftResponse;
    assert.equal(managerShiftBody.shift?.assignedToUserId, staff2.user!.id);
    assert.equal(managerShiftBody.shift?.createdByUserId, manager.user!.id);

    // Create a 3rd shift for date range boundary filtering
    const lateShiftRes = await createShift(
      teamId,
      manager,
      staff1.user!.id,
      '2030-05-28T10:00:00.000Z',
      '2030-05-28T18:00:00.000Z'
    );
    assert.equal(lateShiftRes.status, 201);

    // 2. Date filtering (from / to ISO query parameters)
    // Query range between May 10 and May 20 -> should match only Shift 2 (May 15)
    const midRangeRes = await request(
      `/teams/${teamId}/shifts?from=2030-05-10T00:00:00.000Z&to=2030-05-20T00:00:00.000Z`,
      { headers: { authorization: `Bearer ${manager.accessToken}` } }
    );
    assert.equal(midRangeRes.status, 200);
    const midRangeBody = (await midRangeRes.json()) as ShiftResponse;
    assert.equal(midRangeBody.pagination?.total, 1);
    assert.equal(midRangeBody.shifts?.[0].id, managerShiftBody.shift!.id);

    // Query with from only -> should return May 15 and May 28 shifts (2 shifts)
    const fromOnlyRes = await request(
      `/teams/${teamId}/shifts?from=2030-05-10T00:00:00.000Z`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } }
    );
    assert.equal(fromOnlyRes.status, 200);
    const fromOnlyBody = (await fromOnlyRes.json()) as ShiftResponse;
    assert.equal(fromOnlyBody.pagination?.total, 2);

    // Query with to only -> should return May 1 and May 15 shifts (2 shifts)
    const toOnlyRes = await request(
      `/teams/${teamId}/shifts?to=2030-05-20T00:00:00.000Z`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } }
    );
    assert.equal(toOnlyRes.status, 200);
    const toOnlyBody = (await toOnlyRes.json()) as ShiftResponse;
    assert.equal(toOnlyBody.pagination?.total, 2);

    // 3. Shift reassignment
    // Manager reassigns Shift 1 from staff1 to staff2
    const reassignRes = await jsonRequest(
      `/teams/${teamId}/shifts/${ownerShiftBody.shift!.id}`,
      manager.accessToken,
      {
        assignedToUserId: staff2.user!.id,
        title: 'Reassigned to Staff 2',
        updatedAt: ownerShiftBody.shift!.updatedAt,
      },
      'PATCH'
    );
    assert.equal(reassignRes.status, 200);
    const reassignBody = (await reassignRes.json()) as ShiftResponse;
    assert.equal(reassignBody.shift?.assignedToUserId, staff2.user!.id);
    assert.equal(reassignBody.shift?.title, 'Reassigned to Staff 2');
    assert.equal(reassignBody.shift?.assignedTo?.email, staff2.user!.email);

    // Reassignment to non-team member is rejected with 404
    const foreignUser = await register();
    const rejectNonMember = await jsonRequest(
      `/teams/${teamId}/shifts/${ownerShiftBody.shift!.id}`,
      manager.accessToken,
      {
        assignedToUserId: foreignUser.user!.id,
        updatedAt: reassignBody.shift!.updatedAt,
      },
      'PATCH'
    );
    assert.equal(rejectNonMember.status, 404);
  });

  it('R04.2: shift cancellation audit metadata (cancelledByUserId, cancelledAt), RBAC, optimistic concurrency and stale-update rejection', async () => {
    const owner = await register();
    const manager = await register();
    const staff = await register();

    const teamId = await createTeam(owner, 'R04.2 Team');
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');
    await addMember(teamId, owner, staff.user!.id, 'STAFF');

    // Create two shifts to cancel: one by owner, one by manager
    const shift1Res = await createShift(
      teamId,
      owner,
      staff.user!.id,
      '2030-06-01T09:00:00.000Z',
      '2030-06-01T17:00:00.000Z'
    );
    const shift1Body = (await shift1Res.json()) as ShiftResponse;
    const shift1 = shift1Body.shift!;

    const shift2Res = await createShift(
      teamId,
      manager,
      staff.user!.id,
      '2030-06-02T09:00:00.000Z',
      '2030-06-02T17:00:00.000Z'
    );
    const shift2Body = (await shift2Res.json()) as ShiftResponse;
    const shift2 = shift2Body.shift!;

    // 1. RBAC: Staff cannot cancel shift -> HTTP 403
    const staffCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shift1.id}/cancel`,
      staff.accessToken,
      { updatedAt: shift1.updatedAt }
    );
    assert.equal(staffCancel.status, 403);
    const staffCancelBody = (await staffCancel.json()) as { message: string };
    assert.equal(staffCancelBody.message, 'Insufficient team permissions');

    // 2. Optimistic concurrency & stale-update rejection:
    // Stale timestamp provided -> HTTP 409
    const staleCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shift1.id}/cancel`,
      manager.accessToken,
      { updatedAt: '2028-01-01T00:00:00.000Z' }
    );
    assert.equal(staleCancel.status, 409);
    const staleCancelBody = (await staleCancel.json()) as { message: string };
    assert.equal(staleCancelBody.message, 'Shift has changed; reload before retrying');

    // 3. Manager cancels shift 1 -> HTTP 200 with full audit metadata
    const beforeCancel = Date.now();
    const managerCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shift1.id}/cancel`,
      manager.accessToken,
      { updatedAt: shift1.updatedAt }
    );
    assert.equal(managerCancel.status, 200);
    const managerCancelBody = (await managerCancel.json()) as ShiftResponse;
    const cancelledShift1 = managerCancelBody.shift!;

    assert.equal(cancelledShift1.status, 'CANCELLED');
    assert.equal(cancelledShift1.cancelledByUserId, manager.user!.id);
    assert.ok(cancelledShift1.cancelledAt);
    const cancelledTime = new Date(cancelledShift1.cancelledAt).getTime();
    assert.ok(
      Math.abs(cancelledTime - beforeCancel) < 60000,
      'cancelledAt timestamp must reflect cancellation time'
    );

    // Verify persisted in PostgreSQL
    const dbShift1 = await prisma.shift.findUnique({ where: { id: shift1.id } });
    assert.equal(dbShift1?.status, 'CANCELLED');
    assert.equal(dbShift1?.cancelledByUserId, manager.user!.id);
    assert.ok(dbShift1?.cancelledAt);

    // 4. Repeated cancellation rejected: Already-cancelled shift -> HTTP 409
    const repeatCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shift1.id}/cancel`,
      owner.accessToken,
      { updatedAt: cancelledShift1.updatedAt }
    );
    assert.equal(repeatCancel.status, 409);
    const repeatCancelBody = (await repeatCancel.json()) as { message: string };
    assert.equal(repeatCancelBody.message, 'Shift is already cancelled');

    // 5. Updating a cancelled shift is rejected -> HTTP 409
    const updateCancelled = await jsonRequest(
      `/teams/${teamId}/shifts/${shift1.id}`,
      owner.accessToken,
      { title: 'Attempt to revive', updatedAt: cancelledShift1.updatedAt },
      'PATCH'
    );
    assert.equal(updateCancelled.status, 409);
    const updateCancelledBody = (await updateCancelled.json()) as { message: string };
    assert.equal(updateCancelledBody.message, 'Cancelled shifts cannot be updated');

    // 6. Owner cancels shift 2 -> HTTP 200 with owner attribution
    const ownerCancel = await jsonRequest(
      `/teams/${teamId}/shifts/${shift2.id}/cancel`,
      owner.accessToken,
      { updatedAt: shift2.updatedAt }
    );
    assert.equal(ownerCancel.status, 200);
    const ownerCancelBody = (await ownerCancel.json()) as ShiftResponse;
    assert.equal(ownerCancelBody.shift?.status, 'CANCELLED');
    assert.equal(ownerCancelBody.shift?.cancelledByUserId, owner.user!.id);
  });
});
