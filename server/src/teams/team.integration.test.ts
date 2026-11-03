import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';

interface AuthResponse {
  user?: { id: string };
  accessToken?: string;
}

interface TeamResponse {
  team?: { id: string; name: string; createdByUserId: string };
  teams?: Array<{ id: string; name: string }>;
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = async (
  path: string,
  options: RequestInit = {}
): Promise<Response> => fetch(`${baseUrl}${path}`, options);

const register = async (): Promise<AuthResponse> => {
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `team-test-${randomUUID()}@example.com`,
      name: 'Team Test User',
      password: 'correct horse battery staple',
    }),
  });
  const body = (await response.json()) as AuthResponse;
  createdUserIds.push(body.user!.id);
  return body;
};

const createTeam = async (accessToken: string, body: Record<string, unknown>) =>
  request('/teams', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

const authenticatedGet = (path: string, accessToken: string) =>
  request(path, { headers: { authorization: `Bearer ${accessToken}` } });

const skipReason = authIntegrationSkipReason();

describe('team management API', { concurrency: false, skip: skipReason }, () => {
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

  it('rejects unauthenticated team requests', async () => {
    const createResponse = await request('/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Private Team' }),
    });
    const listResponse = await request('/teams');
    const getResponse = await request(`/teams/${randomUUID()}`);

    assert.equal(createResponse.status, 401);
    assert.equal(listResponse.status, 401);
    assert.equal(getResponse.status, 401);
  });

  it('validates team names', async () => {
    const auth = await register();
    const response = await createTeam(auth.accessToken!, { name: '   ' });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, 'Validation failed');
  });

  it('creates a team and makes the authenticated creator its owner', async () => {
    const auth = await register();
    const response = await createTeam(auth.accessToken!, {
      name: '  Operations  ',
      userId: randomUUID(),
      role: 'STAFF',
    });
    const body = (await response.json()) as TeamResponse;
    createdTeamIds.push(body.team!.id);
    const membership = await prisma.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId: body.team!.id, userId: auth.user!.id },
      },
    });

    assert.equal(response.status, 201);
    assert.equal(body.team?.name, 'Operations');
    assert.equal(body.team?.createdByUserId, auth.user?.id);
    assert.equal(membership?.role, 'OWNER');
    assert.equal(membership?.userId, auth.user?.id);
  });

  it('isolates team listing and retrieval between users', async () => {
    const firstAuth = await register();
    const secondAuth = await register();
    const firstCreate = await createTeam(firstAuth.accessToken!, { name: 'First Team' });
    const firstBody = (await firstCreate.json()) as TeamResponse;
    createdTeamIds.push(firstBody.team!.id);

    const firstList = await authenticatedGet('/teams', firstAuth.accessToken!);
    const secondList = await authenticatedGet('/teams', secondAuth.accessToken!);
    const firstTeamForSecondUser = await authenticatedGet(
      `/teams/${firstBody.team!.id}`,
      secondAuth.accessToken!
    );
    const secondTeamForFirstUser = await createTeam(secondAuth.accessToken!, {
      name: 'Second Team',
    });
    const secondBody = (await secondTeamForFirstUser.json()) as TeamResponse;
    createdTeamIds.push(secondBody.team!.id);
    const firstUserAccessToSecondTeam = await authenticatedGet(
      `/teams/${secondBody.team!.id}`,
      firstAuth.accessToken!
    );

    assert.equal(firstList.status, 200);
    assert.deepEqual((await firstList.json() as TeamResponse).teams?.map((team) => team.id), [
      firstBody.team!.id,
    ]);
    assert.equal(secondList.status, 200);
    assert.deepEqual((await secondList.json() as TeamResponse).teams, []);
    assert.equal(firstTeamForSecondUser.status, 404);
    assert.equal(firstUserAccessToSecondTeam.status, 404);
  });

  it('R03.1: multi-tenant data isolation: missing membership returns 404, permission denial returns 403, and users cannot access foreign-team data', async () => {
    const ownerA = await register();
    const staffA = await register();
    const ownerB = await register();

    const teamARes = await createTeam(ownerA.accessToken!, { name: 'Tenant Team A' });
    const teamABody = (await teamARes.json()) as TeamResponse;
    const teamAId = teamABody.team!.id;
    createdTeamIds.push(teamAId);

    const teamBRes = await createTeam(ownerB.accessToken!, { name: 'Tenant Team B' });
    const teamBBody = (await teamBRes.json()) as TeamResponse;
    const teamBId = teamBBody.team!.id;
    createdTeamIds.push(teamBId);

    // Add staffA to Team A as STAFF
    const addStaffRes = await request(`/teams/${teamAId}/members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerA.accessToken}`,
      },
      body: JSON.stringify({ userId: staffA.user!.id, role: 'STAFF' }),
    });
    assert.equal(addStaffRes.status, 201);

    // 1. Missing membership returns 404 (preventing tenant enumeration)
    // Non-member ownerB attempting to access Team A's endpoints gets 404
    const nonMemberTeamGet = await authenticatedGet(`/teams/${teamAId}`, ownerB.accessToken!);
    assert.equal(nonMemberTeamGet.status, 404);

    const nonMemberMembersGet = await authenticatedGet(`/teams/${teamAId}/members`, ownerB.accessToken!);
    assert.equal(nonMemberMembersGet.status, 404);

    const nonMemberShiftsGet = await authenticatedGet(`/teams/${teamAId}/shifts`, ownerB.accessToken!);
    assert.equal(nonMemberShiftsGet.status, 404);

    const nonMemberBillingGet = await authenticatedGet(`/teams/${teamAId}/billing`, ownerB.accessToken!);
    assert.equal(nonMemberBillingGet.status, 404);

    const nonMemberMemberAdd = await request(`/teams/${teamAId}/members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerB.accessToken}`,
      },
      body: JSON.stringify({ userId: ownerB.user!.id, role: 'STAFF' }),
    });
    assert.equal(nonMemberMemberAdd.status, 404);

    // Completely nonexistent team ID returns identical 404
    const nonexistentTeamId = randomUUID();
    const nonexistentTeamGet = await authenticatedGet(`/teams/${nonexistentTeamId}`, ownerB.accessToken!);
    assert.equal(nonexistentTeamGet.status, 404);
    const nonexistentMembersGet = await authenticatedGet(`/teams/${nonexistentTeamId}/members`, ownerB.accessToken!);
    assert.equal(nonexistentMembersGet.status, 404);

    // 2. Insufficient permissions on a team where the user IS a member returns 403 (NOT 404)
    // staffA is a verified member of Team A, but has role STAFF (cannot MANAGE_TEAM or billing)
    const staffMemberAdd = await request(`/teams/${teamAId}/members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${staffA.accessToken}`,
      },
      body: JSON.stringify({ userId: ownerB.user!.id, role: 'STAFF' }),
    });
    assert.equal(staffMemberAdd.status, 403);
    const staffAddBody = (await staffMemberAdd.json()) as { message: string };
    assert.equal(staffAddBody.message, 'Insufficient team permissions');

    const staffBillingGet = await authenticatedGet(`/teams/${teamAId}/billing`, staffA.accessToken!);
    assert.equal(staffBillingGet.status, 403);
    const staffBillingBody = (await staffBillingGet.json()) as { message: string };
    assert.equal(staffBillingBody.message, 'Insufficient team permissions');

    // 3. Foreign-team data isolation on list queries
    const ownerAList = await authenticatedGet('/teams', ownerA.accessToken!);
    const ownerABody = (await ownerAList.json()) as TeamResponse;
    const ownerATeamIds = ownerABody.teams?.map((t) => t.id) ?? [];
    assert.ok(ownerATeamIds.includes(teamAId));
    assert.ok(!ownerATeamIds.includes(teamBId));

    const ownerBList = await authenticatedGet('/teams', ownerB.accessToken!);
    const ownerBBody = (await ownerBList.json()) as TeamResponse;
    const ownerBTeamIds = ownerBBody.teams?.map((t) => t.id) ?? [];
    assert.ok(ownerBTeamIds.includes(teamBId));
    assert.ok(!ownerBTeamIds.includes(teamAId));

    const staffAList = await authenticatedGet('/teams', staffA.accessToken!);
    const staffABody = (await staffAList.json()) as TeamResponse;
    const staffATeamIds = staffABody.teams?.map((t) => t.id) ?? [];
    assert.ok(staffATeamIds.includes(teamAId));
    assert.ok(!staffATeamIds.includes(teamBId));
  });
});
