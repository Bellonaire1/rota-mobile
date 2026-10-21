import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { app } from '../app';
import { prisma } from '../database/prisma';

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

describe('team management API', () => {
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
});
