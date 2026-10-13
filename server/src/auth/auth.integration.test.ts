import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { after, before, describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { app } from '../app';
import { env } from '../config/env';
import { prisma } from '../database/prisma';
import { hashRefreshToken } from './tokens';

interface AuthResponse {
  user?: {
    id: string;
    email: string;
    name: string | null;
    passwordHash?: string;
  };
  accessToken?: string;
  refreshToken?: string;
}

const createdUserIds: string[] = [];
const createdEmails: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const post = async (path: string, body: Record<string, string>) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = async (path: string, accessToken: string) =>
  fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

const register = async (suffix = randomUUID()): Promise<AuthResponse> => {
  const email = `auth-test-${suffix}@example.com`;
  createdEmails.push(email);
  const response = await post('/auth/register', {
    email,
    name: 'Auth Test User',
    password: 'correct horse battery staple',
  });
  const body = (await response.json()) as AuthResponse;
  if (body.user) createdUserIds.push(body.user.id);
  return body;
};

describe('authentication API', () => {
  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.$disconnect();
  });

  it('registration succeeds, normalizes email, hashes password, and returns no hash', async () => {
    const suffix = randomUUID();
    const email = `auth-test-${suffix}@example.com`;
    createdEmails.push(email);
    const response = await post('/auth/register', {
      email: `  ${email.toUpperCase()}  `,
      name: 'Auth Test User',
      password: 'correct horse battery staple',
    });
    const body = (await response.json()) as AuthResponse;
    createdUserIds.push(body.user!.id);
    const stored = await prisma.user.findUnique({ where: { email } });

    assert.equal(response.status, 201);
    assert.equal(body.user?.email, email);
    assert.equal(body.user?.passwordHash, undefined);
    assert.notEqual(stored?.passwordHash, 'correct horse battery staple');
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
  });

  it('rejects duplicate normalized emails', async () => {
    const suffix = randomUUID();
    const first = await register(suffix);
    assert.ok(first.user);
    const response = await post('/auth/register', {
      email: ` AUTH-TEST-${suffix}@EXAMPLE.COM `,
      name: 'Duplicate User',
      password: 'correct horse battery staple',
    });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).message, 'An account with that email already exists');
  });

  it('allows valid login and rejects an invalid password generically', async () => {
    const suffix = randomUUID();
    const registered = await register(suffix);
    const email = `auth-test-${suffix}@example.com`;
    const validResponse = await post('/auth/login', {
      email: ` ${email.toUpperCase()} `,
      password: 'correct horse battery staple',
    });
    const invalidResponse = await post('/auth/login', {
      email,
      password: 'wrong password',
    });
    const validBody = (await validResponse.json()) as AuthResponse;

    assert.equal(validResponse.status, 200);
    assert.equal(validBody.user?.id, registered.user?.id);
    assert.equal(validBody.user?.passwordHash, undefined);
    assert.equal(invalidResponse.status, 401);
    assert.equal((await invalidResponse.json()).message, 'Invalid email or password');
  });

  it('authenticates protected access-token requests', async () => {
    const body = await register();
    const response = await get('/auth/me', body.accessToken!);
    const me = (await response.json()) as AuthResponse;

    assert.equal(response.status, 200);
    assert.equal(me.user?.id, body.user?.id);
    assert.equal(me.user?.passwordHash, undefined);
  });

  it('rejects invalid and expired access tokens', async () => {
    const invalidResponse = await get('/auth/me', 'not-a-jwt');
    const expiredToken = jwt.sign({ typ: 'access' }, env.JWT_ACCESS_SECRET, {
      subject: randomUUID(),
      expiresIn: -1,
    });
    const expiredResponse = await get('/auth/me', expiredToken);

    assert.equal(invalidResponse.status, 401);
    assert.equal(expiredResponse.status, 401);
  });

  it('refreshes successfully and rotates the refresh token', async () => {
    const body = await register();
    const response = await post('/auth/refresh', { refreshToken: body.refreshToken! });
    const rotated = (await response.json()) as AuthResponse;

    assert.equal(response.status, 200);
    assert.ok(rotated.accessToken);
    assert.ok(rotated.refreshToken);
    assert.notEqual(rotated.refreshToken, body.refreshToken);
  });

  it('rejects an old refresh token and revokes its token family on reuse', async () => {
    const body = await register();
    const rotatedResponse = await post('/auth/refresh', { refreshToken: body.refreshToken! });
    const rotated = (await rotatedResponse.json()) as AuthResponse;
    const reuseResponse = await post('/auth/refresh', { refreshToken: body.refreshToken! });
    const rotatedReuseResponse = await post('/auth/refresh', {
      refreshToken: rotated.refreshToken!,
    });
    const oldSession = await prisma.authSession.findUnique({
      where: { tokenHash: hashRefreshToken(body.refreshToken!) },
    });
    const familySessions = await prisma.authSession.findMany({
      where: { familyId: oldSession!.familyId },
    });

    assert.equal(reuseResponse.status, 401);
    assert.equal(rotatedReuseResponse.status, 401);
    assert.ok(familySessions.every((session) => session.revokedAt));
  });

  it('rejects an expired refresh token', async () => {
    const body = await register();
    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashRefreshToken(body.refreshToken!) },
    });
    await prisma.authSession.update({
      where: { id: session!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await post('/auth/refresh', { refreshToken: body.refreshToken! });

    assert.equal(response.status, 401);
  });

  it('rejects an access token when used as a refresh token', async () => {
    const body = await register();
    const response = await post('/auth/refresh', { refreshToken: body.accessToken! });

    assert.equal(response.status, 401);
  });

  it('rejects a refresh token on protected access-token routes', async () => {
    const body = await register();
    const response = await get('/auth/me', body.refreshToken!);

    assert.equal(response.status, 401);
  });

  it('logout revokes the current refresh session', async () => {
    const body = await register();
    const logoutResponse = await post('/auth/logout', { refreshToken: body.refreshToken! });
    const refreshResponse = await post('/auth/refresh', { refreshToken: body.refreshToken! });

    assert.equal(logoutResponse.status, 200);
    assert.equal(refreshResponse.status, 401);
  });

  it('logout-all revokes every refresh session for the user', async () => {
    const first = await register();
    const secondLoginResponse = await post('/auth/login', {
      email: ` ${first.user!.email} `,
      password: 'correct horse battery staple',
    });
    const second = (await secondLoginResponse.json()) as AuthResponse;
    const unauthenticatedLogoutAll = await post('/auth/logout-all', {});
    const authenticatedLogoutAll = await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    const firstRefresh = await post('/auth/refresh', { refreshToken: first.refreshToken! });
    const secondRefresh = await post('/auth/refresh', { refreshToken: second.refreshToken! });

    assert.equal(unauthenticatedLogoutAll.status, 401);
    assert.equal(secondLoginResponse.status, 200);
    assert.equal(authenticatedLogoutAll.status, 200);
    assert.equal(firstRefresh.status, 401);
    assert.equal(secondRefresh.status, 401);
  });
});
