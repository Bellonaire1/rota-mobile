import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';

interface AuthResponse {
  user?: { id: string };
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
    updatedAt: string;
  };
  shifts?: Array<{ id: string; status: string }>;
  pagination?: { total: number; totalPages: number };
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

describe('shift scheduling API', () => {
  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
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
});
