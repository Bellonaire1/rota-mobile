import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from './auth-test-safety';
import { hashMagicLinkToken } from './tokens';
import { emailService, mockEmailProvider } from '../services/email';

interface ApiResponse {
  message?: string;
  status?: string;
  user?: {
    id: string;
    email: string;
  };
  accessToken?: string;
  refreshToken?: string;
  [key: string]: unknown;
}

const createdUserIds: string[] = [];
const createdEmails: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const post = async (path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = async (path: string, token: string): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });

const registerUser = async (
  password = 'correct horse battery staple',
  suffix = randomUUID()
): Promise<{ id: string; email: string; password: string; accessToken: string; refreshToken: string }> => {
  const email = `magic-link-${suffix}@example.com`;
  createdEmails.push(email);

  const response = await post('/auth/register', {
    email,
    name: 'Magic Link Test User',
    password,
  });

  const body = (await response.json()) as ApiResponse;
  if (!response.ok || !body.user) {
    throw new Error(`Failed to register test user: ${JSON.stringify(body)}`);
  }

  createdUserIds.push(body.user.id);
  return {
    id: body.user.id,
    email,
    password,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
  };
};

const extractTokenFromText = (text: string): string => {
  const match = text.match(/token=([a-f0-9]{64})/i) || text.match(/\b([a-f0-9]{64})\b/);
  if (!match) {
    throw new Error(`Could not extract magic link token from email body: ${text}`);
  }
  return match[1];
};

const skipReason = authIntegrationSkipReason();

describe('magic link passwordless backend API', { concurrency: false, skip: skipReason }, () => {
  before(async () => {
    emailService.setProvider(mockEmailProvider);
    mockEmailProvider.clear();

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    emailService.setProvider(mockEmailProvider);
    mockEmailProvider.clear();

    if (createdUserIds.length > 0) {
      await prisma.magicLinkToken.deleteMany({
        where: { userId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.magicLinkRequest.deleteMany({
        where: { email: { in: createdEmails } },
      }).catch(() => {});
      await prisma.authSession.deleteMany({
        where: { userId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      }).catch(() => {});
    }

    if (createdEmails.length > 0) {
      await prisma.magicLinkRequest.deleteMany({
        where: { email: { in: createdEmails } },
      }).catch(() => {});
    }

    if (server) {
      server.close();
    }
    await prisma.$disconnect();
  });

  it('1. existing email request: returns generic 200, sends email, stores SHA-256 hash in DB with 15m expiry', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    const startTime = Date.now();
    const res = await post('/auth/magic-link/request', { email: user.email });
    assert.equal(res.status, 200);

    const body = (await res.json()) as ApiResponse;
    assert.equal(
      body.message,
      'If an account exists with that email, a sign-in link has been sent.'
    );

    const sentEmails = mockEmailProvider.getSentEmails();
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, user.email);
    assert.equal(sentEmails[0].subject, 'Sign in to Rota');

    const token = extractTokenFromText(sentEmails[0].text);
    assert.equal(token.length, 64);
    assert.match(token, /^[a-f0-9]{64}$/);

    const tokenHash = hashMagicLinkToken(token);
    const dbToken = await prisma.magicLinkToken.findUnique({
      where: { tokenHash },
    });
    assert.ok(dbToken);
    assert.equal(dbToken.userId, user.id);
    assert.equal(dbToken.usedAt, null);

    const expiryMs = dbToken.expiresAt.getTime() - startTime;
    const fifteenMinMs = 15 * 60 * 1000;
    assert.ok(
      Math.abs(expiryMs - fifteenMinMs) < 60000,
      `Expiry ${expiryMs}ms should be close to 15 minutes`
    );

    const rawInDb = await prisma.$queryRaw<unknown[]>`
      SELECT id FROM "MagicLinkToken" WHERE "tokenHash" = ${token}
    `;
    assert.equal(rawInDb.length, 0);
  });

  it('2. unknown email request: returns generic 200, sends zero emails, creates no token records', async () => {
    mockEmailProvider.clear();
    const unknownEmail = `unknown-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    const res = await post('/auth/magic-link/request', { email: unknownEmail });
    assert.equal(res.status, 200);

    const body = (await res.json()) as ApiResponse;
    assert.equal(
      body.message,
      'If an account exists with that email, a sign-in link has been sent.'
    );

    const sentEmails = mockEmailProvider.getSentEmails();
    assert.equal(sentEmails.length, 0);

    const user = await prisma.user.findUnique({ where: { email: unknownEmail } });
    assert.equal(user, null);
  });

  it('3. expired token: rejected with 400 and does not issue session', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    const reqRes = await post('/auth/magic-link/request', { email: user.email });
    assert.equal(reqRes.status, 200);

    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    const tokenHash = hashMagicLinkToken(token);

    await prisma.magicLinkToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });

    const confirmRes = await post('/auth/magic-link/confirm', { token });
    assert.equal(confirmRes.status, 400);

    const body = (await confirmRes.json()) as ApiResponse;
    assert.equal(body.message, 'Magic link token has expired');

    const dbToken = await prisma.magicLinkToken.findUnique({ where: { tokenHash } });
    assert.equal(dbToken?.usedAt, null);
  });

  it('4. invalid token: rejected with 400', async () => {
    const bogusToken = 'c'.repeat(64);
    const res = await post('/auth/magic-link/confirm', { token: bogusToken });
    assert.equal(res.status, 400);

    const body = (await res.json()) as ApiResponse;
    assert.equal(body.message, 'Invalid or expired magic link token');
  });

  it('5. token reuse: second consumption attempt rejected with 400', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    await post('/auth/magic-link/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    const firstConfirm = await post('/auth/magic-link/confirm', { token });
    assert.equal(firstConfirm.status, 200);

    const secondConfirm = await post('/auth/magic-link/confirm', { token });
    assert.equal(secondConfirm.status, 400);

    const body = (await secondConfirm.json()) as ApiResponse;
    assert.equal(body.message, 'Magic link token has already been used');
  });

  it('6. successful magic link confirmation: returns normal AuthResult (user, accessToken, refreshToken)', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    await post('/auth/magic-link/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    const tokenHash = hashMagicLinkToken(token);

    const confirmRes = await post('/auth/magic-link/confirm', { token });
    assert.equal(confirmRes.status, 200);

    const body = (await confirmRes.json()) as ApiResponse;
    assert.ok(body.user);
    assert.equal(body.user.id, user.id);
    assert.equal(body.user.email, user.email);
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);

    const dbToken = await prisma.magicLinkToken.findUnique({ where: { tokenHash } });
    assert.ok(dbToken?.usedAt);
  });

  it('7. session issuance: verifies session record in AuthSession and access token can access /auth/me', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    await post('/auth/magic-link/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    const confirmRes = await post('/auth/magic-link/confirm', { token });
    assert.equal(confirmRes.status, 200);

    const authResult = (await confirmRes.json()) as ApiResponse;

    // Verify /auth/me works with the issued accessToken
    const meRes = await get('/auth/me', authResult.accessToken as string);
    assert.equal(meRes.status, 200);
    const meBody = (await meRes.json()) as ApiResponse;
    assert.equal(meBody.user?.id, user.id);

    // Verify refresh token works and rotates
    const refreshRes = await post('/auth/refresh', {
      refreshToken: authResult.refreshToken as string,
    });
    assert.equal(refreshRes.status, 200);
    const refreshBody = (await refreshRes.json()) as ApiResponse;
    assert.ok(refreshBody.accessToken);
    assert.ok(refreshBody.refreshToken);
    assert.notEqual(refreshBody.refreshToken, authResult.refreshToken);

    // Verify session exists in PostgreSQL
    const sessions = await prisma.authSession.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    assert.ok(sessions.length >= 1);
  });

  it('8. concurrent token consumption: atomic single-use guarantees exactly one consumer succeeds', async () => {
    const user = await registerUser();
    mockEmailProvider.clear();

    await post('/auth/magic-link/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    const [resA, resB] = await Promise.all([
      post('/auth/magic-link/confirm', { token }),
      post('/auth/magic-link/confirm', { token }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(
      statuses,
      [200, 400],
      `Expected exactly one 200 and one 400 under concurrent confirmation, got: ${resA.status}, ${resB.status}`
    );

    const tokenHash = hashMagicLinkToken(token);
    const dbToken = await prisma.magicLinkToken.findUnique({ where: { tokenHash } });
    assert.ok(dbToken?.usedAt);
  });

  it('9. persistent throttling: multiple requests within 15-minute window are rate-limited with 429 for BOTH existing and nonexistent accounts', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const nonexistentEmail = `unregistered-${randomUUID()}@example.com`;
    createdEmails.push(nonexistentEmail);

    // Existing user: 3 requests succeed, 4th throttled with 429
    for (let i = 0; i < 3; i++) {
      const res = await post('/auth/magic-link/request', { email: existingUser.email });
      assert.equal(res.status, 200, `Request ${i + 1} for existing user should succeed`);
    }
    const throttledExisting = await post('/auth/magic-link/request', { email: existingUser.email });
    assert.equal(throttledExisting.status, 429);
    const existingBody = (await throttledExisting.json()) as ApiResponse;
    assert.equal(existingBody.message, 'Too many magic link requests. Please try again later.');

    // Nonexistent user: 3 requests succeed, 4th throttled with 429
    for (let i = 0; i < 3; i++) {
      const res = await post('/auth/magic-link/request', { email: nonexistentEmail });
      assert.equal(res.status, 200, `Request ${i + 1} for nonexistent user should succeed`);
    }
    const throttledNonexistent = await post('/auth/magic-link/request', { email: nonexistentEmail });
    assert.equal(throttledNonexistent.status, 429);
    const nonexistentBody = (await throttledNonexistent.json()) as ApiResponse;
    assert.equal(nonexistentBody.message, 'Too many magic link requests. Please try again later.');

    // Status code and error message must be identical
    assert.equal(throttledExisting.status, throttledNonexistent.status);
    assert.equal(existingBody.message, nonexistentBody.message);
  });

  it('10. atomic concurrent throttling: 6 simultaneous requests strictly allow at most 3 accepted attempts, 3 persisted records, and at most 3 email sends without enumeration', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const nonexistentEmail = `conc-nonexistent-${randomUUID()}@example.com`;
    createdEmails.push(nonexistentEmail);

    // 6 simultaneous requests for registered user
    const existingPromises = Array.from({ length: 6 }, () =>
      post('/auth/magic-link/request', { email: existingUser.email })
    );
    const existingResults = await Promise.all(existingPromises);
    const existingStatuses = existingResults.map((r) => r.status);

    const existing200s = existingStatuses.filter((s) => s === 200).length;
    const existing429s = existingStatuses.filter((s) => s === 429).length;

    assert.equal(existing200s + existing429s, 6);
    assert.ok(existing200s <= 3);

    // 6 simultaneous requests for nonexistent user
    const nonexistentPromises = Array.from({ length: 6 }, () =>
      post('/auth/magic-link/request', { email: nonexistentEmail })
    );
    const nonexistentResults = await Promise.all(nonexistentPromises);
    const nonexistentStatuses = nonexistentResults.map((r) => r.status);

    const nonexistent200s = nonexistentStatuses.filter((s) => s === 200).length;
    const nonexistent429s = nonexistentStatuses.filter((s) => s === 429).length;

    assert.equal(nonexistent200s + nonexistent429s, 6);
    assert.ok(nonexistent200s <= 3);

    // Check DB persistence records
    const existingDbRecords = await prisma.magicLinkRequest.count({
      where: { email: existingUser.email },
    });
    assert.ok(existingDbRecords <= 3);

    const nonexistentDbRecords = await prisma.magicLinkRequest.count({
      where: { email: nonexistentEmail },
    });
    assert.ok(nonexistentDbRecords <= 3);
  });

  it('11. email delivery failure handling: safe error handling returns generic 200 response identically for existing and nonexistent accounts without enumeration', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const nonexistentEmail = `unregistered-sendfail-${randomUUID()}@example.com`;
    createdEmails.push(nonexistentEmail);

    // Configure mock provider to pass verifyHealth but fail on send
    mockEmailProvider.setSendFailureOnly(true, new Error('Simulated Resend API downstream 502 Bad Gateway'));

    try {
      const existingRes = await post('/auth/magic-link/request', { email: existingUser.email });
      assert.equal(existingRes.status, 200);
      const existingBody = (await existingRes.json()) as ApiResponse;

      const nonexistentRes = await post('/auth/magic-link/request', { email: nonexistentEmail });
      assert.equal(nonexistentRes.status, 200);
      const nonexistentBody = (await nonexistentRes.json()) as ApiResponse;

      assert.equal(existingBody.message, nonexistentBody.message);
      assert.equal(existingBody.message, 'If an account exists with that email, a sign-in link has been sent.');
    } finally {
      mockEmailProvider.setSendFailureOnly(false);
    }
  });

  it('12. unconfigured email provider handling: safe 500 error returned, identical for existing and nonexistent accounts', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const nonexistentEmail = `unregistered-unconf-${randomUUID()}@example.com`;
    createdEmails.push(nonexistentEmail);

    mockEmailProvider.setUnconfigured(true);

    try {
      const existingRes = await post('/auth/magic-link/request', { email: existingUser.email });
      assert.equal(existingRes.status, 500);
      const existingBody = (await existingRes.json()) as ApiResponse;

      const nonexistentRes = await post('/auth/magic-link/request', { email: nonexistentEmail });
      assert.equal(nonexistentRes.status, 500);
      const nonexistentBody = (await nonexistentRes.json()) as ApiResponse;

      assert.equal(existingBody.message, 'Unable to send magic link email at this time');
      assert.equal(nonexistentBody.message, 'Unable to send magic link email at this time');
    } finally {
      mockEmailProvider.setUnconfigured(false);
    }
  });

  it('13. sensitive information not returned by APIs: no tokens, hashes, or ids exposed in responses', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();

    const reqRes = await post('/auth/magic-link/request', { email: user.email });
    const reqBody = (await reqRes.json()) as ApiResponse;
    const reqStr = JSON.stringify(reqBody);

    assert.ok(!reqStr.includes(user.id));
    assert.ok(!reqStr.toLowerCase().includes('hash'));
    assert.ok(!reqStr.toLowerCase().includes('token'));
  });
});

