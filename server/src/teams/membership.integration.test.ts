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

interface MemberResponse {
  member?: { userId: string; role: string };
  members?: Array<{ userId: string; role: string }>;
  pagination?: { page: number; limit: number; total: number; totalPages: number };
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
      email: `membership-test-${randomUUID()}@example.com`,
      name: 'Membership Test User',
      password: 'correct horse battery staple',
    }),
  });
  const body = (await response.json()) as AuthResponse;
  createdUserIds.push(body.user!.id);
  return body;
};

const jsonRequest = (path: string, accessToken: string | undefined, body?: unknown, method = 'POST') =>
  request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createTeam = async (auth: AuthResponse, name = 'Membership Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const addMember = (teamId: string, auth: AuthResponse, userId: string, role?: string) =>
  jsonRequest(`/teams/${teamId}/members`, auth.accessToken, {
    userId,
    ...(role === undefined ? {} : { role }),
  });

describe('team membership API', () => {
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

  it('requires authentication for every membership operation', async () => {
    const teamId = randomUUID();
    const responses = await Promise.all([
      request(`/teams/${teamId}/members`),
      jsonRequest(`/teams/${teamId}/members`, undefined, { userId: randomUUID() }),
      jsonRequest(`/teams/${teamId}/members/${randomUUID()}/role`, undefined, { role: 'STAFF' }, 'PATCH'),
      jsonRequest(`/teams/${teamId}/members/${randomUUID()}`, undefined, undefined, 'DELETE'),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401]);
  });

  it('allows owners to add existing users, rejects duplicates and unknown users, and paginates members', async () => {
    const owner = await register();
    const teamId = await createTeam(owner);
    const users = await Promise.all([register(), register(), register()]);

    assert.equal((await addMember(teamId, owner, users[0].user!.id)).status, 201);
    assert.equal((await addMember(teamId, owner, users[1].user!.id, 'MANAGER')).status, 201);
    assert.equal((await addMember(teamId, owner, users[2].user!.id)).status, 201);
    assert.equal((await addMember(teamId, owner, users[0].user!.id)).status, 409);
    assert.equal((await addMember(teamId, owner, randomUUID())).status, 404);

    const firstPage = await request(`/teams/${teamId}/members?page=1&limit=2`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const secondPage = await request(`/teams/${teamId}/members?page=2&limit=2`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const firstBody = (await firstPage.json()) as MemberResponse;
    const secondBody = (await secondPage.json()) as MemberResponse;

    assert.equal(firstPage.status, 200);
    assert.equal(firstBody.members?.length, 2);
    assert.equal(secondBody.members?.length, 2);
    assert.equal(firstBody.pagination?.total, 4);
    assert.equal(firstBody.pagination?.totalPages, 2);
    assert.equal(secondBody.pagination?.page, 2);
  });

  it('lets members list but restricts mutations to owners and isolates teams', async () => {
    const owner = await register();
    const staff = await register();
    const manager = await register();
    const otherOwner = await register();
    const teamId = await createTeam(owner, 'Owner Team');
    const otherTeamId = await createTeam(otherOwner, 'Other Team');
    await addMember(teamId, owner, staff.user!.id);
    await addMember(teamId, owner, manager.user!.id, 'MANAGER');

    const staffList = await request(`/teams/${teamId}/members`, {
      headers: { authorization: `Bearer ${staff.accessToken}` },
    });
    const managerList = await request(`/teams/${teamId}/members`, {
      headers: { authorization: `Bearer ${manager.accessToken}` },
    });
    const staffAdd = await addMember(teamId, staff, otherOwner.user!.id);
    const managerAdd = await addMember(teamId, manager, otherOwner.user!.id);
    const staffRole = await jsonRequest(
      `/teams/${teamId}/members/${staff.user!.id}/role`,
      staff.accessToken,
      { role: 'MANAGER' },
      'PATCH'
    );
    const managerRemove = await jsonRequest(
      `/teams/${teamId}/members/${staff.user!.id}`,
      manager.accessToken,
      undefined,
      'DELETE'
    );
    const crossTeamList = await request(`/teams/${otherTeamId}/members`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    assert.equal(staffList.status, 200);
    assert.equal(managerList.status, 200);
    assert.equal(staffAdd.status, 403);
    assert.equal(managerAdd.status, 403);
    assert.equal(staffRole.status, 403);
    assert.equal(managerRemove.status, 403);
    assert.equal(crossTeamList.status, 404);
  });

  it('allows owners to change and remove non-owner roles but protects owners', async () => {
    const owner = await register();
    const target = await register();
    const teamId = await createTeam(owner);
    assert.equal((await addMember(teamId, owner, target.user!.id)).status, 201);

    const roleChange = await jsonRequest(
      `/teams/${teamId}/members/${target.user!.id}/role`,
      owner.accessToken,
      { role: 'MANAGER' },
      'PATCH'
    );
    const ownerRoleChange = await jsonRequest(
      `/teams/${teamId}/members/${owner.user!.id}/role`,
      owner.accessToken,
      { role: 'STAFF' },
      'PATCH'
    );
    const removal = await jsonRequest(
      `/teams/${teamId}/members/${target.user!.id}`,
      owner.accessToken,
      undefined,
      'DELETE'
    );
    const ownerRemoval = await jsonRequest(
      `/teams/${teamId}/members/${owner.user!.id}`,
      owner.accessToken,
      undefined,
      'DELETE'
    );
    const missingTarget = await jsonRequest(
      `/teams/${teamId}/members/${target.user!.id}/role`,
      owner.accessToken,
      { role: 'STAFF' },
      'PATCH'
    );

    assert.equal(roleChange.status, 200);
    assert.equal((await roleChange.json() as MemberResponse).member?.role, 'MANAGER');
    assert.equal(ownerRoleChange.status, 403);
    assert.equal(removal.status, 204);
    assert.equal(ownerRemoval.status, 403);
    assert.equal(missingTarget.status, 404);
  });
});
