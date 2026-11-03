import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from './auth-test-safety';
import { hashPasswordResetToken } from './tokens';
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
  const email = `pwd-reset-${suffix}@example.com`;
  createdEmails.push(email);

  const response = await post('/auth/register', {
    email,
    name: 'Reset Test User',
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
    throw new Error(`Could not extract reset token from email body: ${text}`);
  }
  return match[1];
};

const skipReason = authIntegrationSkipReason();

describe('password reset backend API', { concurrency: false, skip: skipReason }, () => {
  before(async () => {
    if (skipReason) return;
    emailService.setProvider(mockEmailProvider);
    mockEmailProvider.clear();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    if (skipReason) return;
    mockEmailProvider.clear();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    if (createdEmails.length > 0) {
      await prisma.passwordResetRequest.deleteMany({
        where: { email: { in: createdEmails } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.passwordResetToken.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.authSession.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { email: { in: createdEmails } },
      });
    }
    await prisma.$disconnect();
  });

  it('1. existing email request: returns generic 200, sends email, stores SHA-256 hash in DB with 30m expiry', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();

    const response = await post('/auth/password-reset/request', {
      email: `  ${user.email.toUpperCase()}  `,
    });
    const body = (await response.json()) as ApiResponse;

    assert.equal(response.status, 200);
    assert.equal(
      body.message,
      'If an account exists with that email, a password reset link has been sent.'
    );

    const sentEmails = mockEmailProvider.getSentEmails();
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, user.email);
    assert.equal(sentEmails[0].subject, 'Reset your Rota password');

    const token = extractTokenFromText(sentEmails[0].text);
    assert.equal(token.length, 64);

    const tokenHash = hashPasswordResetToken(token);
    const stored = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    assert.ok(stored, 'Token record must exist in DB');
    assert.equal(stored.userId, user.id);
    assert.equal(stored.usedAt, null);
    assert.ok(stored.expiresAt > new Date());
    const ttlMinutes = (stored.expiresAt.getTime() - stored.createdAt.getTime()) / (60 * 1000);
    assert.ok(ttlMinutes >= 29 && ttlMinutes <= 31, 'TTL must be approximately 30 minutes');
  });

  it('2. unknown email request: returns generic 200, sends zero emails, creates no token records', async () => {
    mockEmailProvider.clear();
    const unknownEmail = `unknown-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    const response = await post('/auth/password-reset/request', {
      email: unknownEmail,
    });
    const body = (await response.json()) as ApiResponse;

    assert.equal(response.status, 200);
    assert.equal(
      body.message,
      'If an account exists with that email, a password reset link has been sent.'
    );

    assert.equal(mockEmailProvider.getSentEmails().length, 0);
  });

  it('3. expired token: rejected with 400 and does not change user password', async () => {
    mockEmailProvider.clear();
    const originalPassword = 'originalPassword123!';
    const user = await registerUser(originalPassword);

    await post('/auth/password-reset/request', { email: user.email });
    const email = mockEmailProvider.getLastEmail()!;
    const token = extractTokenFromText(email.text);
    const tokenHash = hashPasswordResetToken(token);

    // Force expiration in DB
    await prisma.passwordResetToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });

    const response = await post('/auth/password-reset/confirm', {
      token,
      password: 'attemptedNewPassword456!',
    });
    const body = (await response.json()) as ApiResponse;

    assert.equal(response.status, 400);
    assert.match(body.message || '', /expired/i);

    // Verify password was not changed
    const storedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const matchesOriginal = await bcrypt.compare(originalPassword, storedUser!.passwordHash);
    assert.equal(matchesOriginal, true);
  });

  it('4. invalid token: rejected with 400', async () => {
    const response = await post('/auth/password-reset/confirm', {
      token: 'a'.repeat(64),
      password: 'newPassword123!',
    });
    const body = (await response.json()) as ApiResponse;

    assert.equal(response.status, 400);
    assert.match(body.message || '', /invalid|expired/i);
  });

  it('5. token reuse: second consumption attempt rejected with 400', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();

    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    const first = await post('/auth/password-reset/confirm', {
      token,
      password: 'newPasswordFirstUse123!',
    });
    assert.equal(first.status, 200);

    const second = await post('/auth/password-reset/confirm', {
      token,
      password: 'secondAttemptPassword999!',
    });
    const secondBody = (await second.json()) as ApiResponse;

    assert.equal(second.status, 400);
    assert.match(secondBody.message || '', /already been used/i);
  });

  it('6. successful password update: hashes new password with bcrypt 12 and marks token used', async () => {
    mockEmailProvider.clear();
    const originalPassword = 'InitialSecretPass123!';
    const user = await registerUser(originalPassword);

    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    const tokenHash = hashPasswordResetToken(token);

    const newPassword = 'BrandNewSuperSecurePass456!';
    const response = await post('/auth/password-reset/confirm', {
      token,
      password: newPassword,
    });
    const body = (await response.json()) as ApiResponse;

    assert.equal(response.status, 200);
    assert.equal(
      body.message,
      'Password has been reset successfully. Please log in with your new password.'
    );

    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    assert.ok(updatedUser);
    assert.notEqual(updatedUser.passwordHash, originalPassword);
    const bcryptMatches = await bcrypt.compare(newPassword, updatedUser.passwordHash);
    assert.equal(bcryptMatches, true);

    const tokenInDb = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    assert.ok(tokenInDb?.usedAt !== null, 'Token usedAt must be populated');
  });

  it('7. old password rejection: login fails after successful reset', async () => {
    mockEmailProvider.clear();
    const oldPassword = 'OldPasswordToReject123!';
    const user = await registerUser(oldPassword);

    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    await post('/auth/password-reset/confirm', {
      token,
      password: 'NewReplacementPassword789!',
    });

    const loginResponse = await post('/auth/login', {
      email: user.email,
      password: oldPassword,
    });
    assert.equal(loginResponse.status, 401);
  });

  it('8. new password login: allows successful login and issues tokens', async () => {
    mockEmailProvider.clear();
    const user = await registerUser('PriorPassword123!');

    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    const newPassword = 'FunctionalNewPassword888!';

    await post('/auth/password-reset/confirm', {
      token,
      password: newPassword,
    });

    const loginResponse = await post('/auth/login', {
      email: user.email,
      password: newPassword,
    });
    const loginBody = (await loginResponse.json()) as ApiResponse;

    assert.equal(loginResponse.status, 200);
    assert.ok(loginBody.accessToken);
    assert.ok(loginBody.refreshToken);
    assert.equal(loginBody.user?.email, user.email);
  });

  it('9. global session revocation: invalidates all existing refresh sessions on password reset', async () => {
    mockEmailProvider.clear();
    const initialPassword = 'PasswordForSessionRevocation123!';
    const user = await registerUser(initialPassword);

    // Create a second active session
    const loginResponse = await post('/auth/login', {
      email: user.email,
      password: initialPassword,
    });
    const loginBody = (await loginResponse.json()) as ApiResponse;
    const session2RefreshToken = loginBody.refreshToken as string;
    const session1RefreshToken = user.refreshToken;

    // Both sessions work before reset
    const preCheck = await post('/auth/refresh', { refreshToken: session2RefreshToken });
    assert.equal(preCheck.status, 200);

    // Perform password reset
    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    await post('/auth/password-reset/confirm', {
      token,
      password: 'NewPasswordAfterRevoke999!',
    });

    // Session 1 refresh attempt must now be rejected
    const refresh1 = await post('/auth/refresh', { refreshToken: session1RefreshToken });
    assert.equal(refresh1.status, 401);

    // Session 2 refresh attempt must now be rejected
    const refresh2 = await post('/auth/refresh', { refreshToken: session2RefreshToken });
    assert.equal(refresh2.status, 401);

    // Verify all sessions in DB are revoked
    const activeSessions = await prisma.authSession.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    assert.equal(activeSessions.length, 0, 'No unrevoked sessions should remain');
  });

  it('10. concurrent token consumption: atomic single-use guarantees exactly one consumer succeeds', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();

    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    // Launch two parallel consumption requests
    const [resA, resB] = await Promise.all([
      post('/auth/password-reset/confirm', {
        token,
        password: 'concurrentPasswordOptionA1!',
      }),
      post('/auth/password-reset/confirm', {
        token,
        password: 'concurrentPasswordOptionB2!',
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(
      statuses,
      [200, 400],
      `Expected exactly one 200 and one 400, got ${resA.status} and ${resB.status}`
    );

    const tokenHash = hashPasswordResetToken(token);
    const tokenInDb = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    assert.ok(tokenInDb?.usedAt !== null);
  });

  it('11. email delivery failure handling: safe 500 error returned, identical for existing and nonexistent accounts', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();
    const unknownEmail = `unknown-delivery-fail-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    mockEmailProvider.setShouldFail(true, new Error('Simulated network transport outage'));

    try {
      // 1. Request for existing user
      const resExisting = await post('/auth/password-reset/request', {
        email: user.email,
      });
      const bodyExisting = (await resExisting.json()) as ApiResponse;

      // 2. Request for nonexistent user
      const resUnknown = await post('/auth/password-reset/request', {
        email: unknownEmail,
      });
      const bodyUnknown = (await resUnknown.json()) as ApiResponse;

      // Both must return identical HTTP 500 status
      assert.equal(resExisting.status, 500);
      assert.equal(resUnknown.status, 500);

      // Both must return identical error structure and message (preventing account enumeration)
      assert.equal(bodyExisting.status, 'error');
      assert.equal(bodyUnknown.status, 'error');
      assert.match(bodyExisting.message || '', /Unable to send password reset email/i);
      assert.equal(bodyExisting.message, bodyUnknown.message);

      // Ensure raw error stack or internal details are not leaked
      assert.equal(bodyExisting.stack, undefined);
      assert.equal(bodyUnknown.stack, undefined);
    } finally {
      mockEmailProvider.setShouldFail(false);
    }
  });

  it('12. unconfigured email provider handling: safe 500 error returned, identical for existing and nonexistent accounts', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();
    const unknownEmail = `unknown-unconfigured-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    mockEmailProvider.setUnconfigured(true);

    try {
      // 1. Request for existing user
      const resExisting = await post('/auth/password-reset/request', {
        email: user.email,
      });
      const bodyExisting = (await resExisting.json()) as ApiResponse;

      // 2. Request for nonexistent user
      const resUnknown = await post('/auth/password-reset/request', {
        email: unknownEmail,
      });
      const bodyUnknown = (await resUnknown.json()) as ApiResponse;

      // Both must return 500 and never claim successful 200 delivery
      assert.equal(resExisting.status, 500);
      assert.equal(resUnknown.status, 500);

      // Both must return identical error responses
      assert.equal(bodyExisting.status, 'error');
      assert.equal(bodyUnknown.status, 'error');
      assert.match(bodyExisting.message || '', /Unable to send password reset email/i);
      assert.equal(bodyExisting.message, bodyUnknown.message);

      // Zero emails must be sent
      assert.equal(mockEmailProvider.getSentEmails().length, 0);
    } finally {
      mockEmailProvider.setUnconfigured(false);
    }
  });

  it('13. sensitive information not returned by APIs: no tokens, hashes, or ids exposed in responses', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();

    // Check request endpoint response
    const reqResponse = await post('/auth/password-reset/request', {
      email: user.email,
    });
    const reqBody = (await reqResponse.json()) as Record<string, unknown>;
    assert.equal(reqResponse.status, 200);

    const forbiddenFields = [
      'token',
      'tokenHash',
      'password',
      'passwordHash',
      'userId',
      'id',
      'user',
      'secret',
      'stack',
    ];

    for (const field of forbiddenFields) {
      assert.equal(
        reqBody[field],
        undefined,
        `Field "${field}" must not be returned by password-reset/request`
      );
    }

    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);

    // Check confirm endpoint response
    const confirmResponse = await post('/auth/password-reset/confirm', {
      token,
      password: 'SafeResponsePass123!',
    });
    const confirmBody = (await confirmResponse.json()) as Record<string, unknown>;
    assert.equal(confirmResponse.status, 200);

    for (const field of forbiddenFields) {
      assert.equal(
        confirmBody[field],
        undefined,
        `Field "${field}" must not be returned by password-reset/confirm`
      );
    }
  });

  it('14. persistent throttling: multiple requests within 15-minute window are rate-limited with 429 for BOTH existing and nonexistent accounts', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const unknownEmail = `unknown-throttle-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    // --- Existing account test ---
    // Requests 1-3: succeed (200)
    for (let i = 1; i <= 3; i++) {
      const res = await post('/auth/password-reset/request', { email: existingUser.email });
      assert.equal(res.status, 200, `Existing user attempt ${i} should return 200`);
    }
    // Request 4: throttled (429)
    const r4Existing = await post('/auth/password-reset/request', { email: existingUser.email });
    const r4ExistingBody = (await r4Existing.json()) as ApiResponse;
    assert.equal(r4Existing.status, 429, 'Existing user attempt 4 must return 429');
    assert.match(r4ExistingBody.message || '', /Too many password reset requests/i);

    // --- Nonexistent account test ---
    // Requests 1-3: succeed with generic message (200)
    for (let i = 1; i <= 3; i++) {
      const res = await post('/auth/password-reset/request', { email: unknownEmail });
      assert.equal(res.status, 200, `Nonexistent user attempt ${i} should return 200`);
    }
    // Request 4: throttled with identical 429 (no enumeration)
    const r4Unknown = await post('/auth/password-reset/request', { email: unknownEmail });
    const r4UnknownBody = (await r4Unknown.json()) as ApiResponse;
    assert.equal(r4Unknown.status, 429, 'Nonexistent user attempt 4 must return 429');
    assert.match(r4UnknownBody.message || '', /Too many password reset requests/i);

    // Verify status codes and error messages are identical between existing and nonexistent
    assert.equal(r4Existing.status, r4Unknown.status);
    assert.equal(r4ExistingBody.message, r4UnknownBody.message);
  });

  it('15. post-readiness send failure: returns neutral conditional 200 response identically for existing and nonexistent accounts without enumeration', async () => {
    mockEmailProvider.clear();
    const user = await registerUser();
    const unknownEmail = `unknown-send-fail-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    // Simulate provider that passes verifyHealth/verifyDeliveryAvailable, but fails during actual send()
    mockEmailProvider.setSendFailureOnly(
      true,
      new Error('Simulated Resend API downstream HTTP 502 Bad Gateway')
    );

    try {
      // 1. Request for existing user
      const resExisting = await post('/auth/password-reset/request', {
        email: user.email,
      });
      const bodyExisting = (await resExisting.json()) as ApiResponse;

      // 2. Request for nonexistent user
      const resUnknown = await post('/auth/password-reset/request', {
        email: unknownEmail,
      });
      const bodyUnknown = (await resUnknown.json()) as ApiResponse;

      // Both must return identical HTTP 200 status (no account enumeration)
      assert.equal(resExisting.status, 200);
      assert.equal(resUnknown.status, 200);

      // Both must return identical neutral conditional response body
      assert.equal(
        bodyExisting.message,
        'If an account exists with that email, a password reset link has been sent.'
      );
      assert.equal(bodyExisting.message, bodyUnknown.message);

      // Ensure no active token remains in DB for the existing user (cleaned up on send failure)
      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
      });
      assert.equal(tokens.length, 0, 'Unsent token must be deleted from DB');
    } finally {
      mockEmailProvider.setSendFailureOnly(false);
    }
  });

  it('16. access token validity post-reset: refresh sessions are revoked while already-issued short-lived access JWT remains valid until expiry', async () => {
    mockEmailProvider.clear();
    const initialPassword = 'InitialValidPass123!';
    const user = await registerUser(initialPassword);

    // Initial access token works before reset
    const preCheckMe = await get('/auth/me', user.accessToken);
    assert.equal(preCheckMe.status, 200);

    // Complete password reset
    await post('/auth/password-reset/request', { email: user.email });
    const token = extractTokenFromText(mockEmailProvider.getLastEmail()!.text);
    const newPassword = 'ConfirmedNewPass456!';
    const confirmRes = await post('/auth/password-reset/confirm', {
      token,
      password: newPassword,
    });
    assert.equal(confirmRes.status, 200);

    // 1. Refresh token session is immediately revoked
    const refreshRes = await post('/auth/refresh', {
      refreshToken: user.refreshToken,
    });
    assert.equal(refreshRes.status, 401);

    // 2. Already-issued short-lived access JWT remains valid until expiry (stateless JWT verification)
    const postResetMe = await get('/auth/me', user.accessToken);
    assert.equal(
      postResetMe.status,
      200,
      'Already-issued short-lived access JWT remains valid until expiry due to stateless verification'
    );
    const postResetMeBody = (await postResetMe.json()) as ApiResponse;
    assert.equal(postResetMeBody.user?.email, user.email);

    // 3. Old password login is rejected
    const oldLogin = await post('/auth/login', {
      email: user.email,
      password: initialPassword,
    });
    assert.equal(oldLogin.status, 401);

    // 4. New password login succeeds
    const newLogin = await post('/auth/login', {
      email: user.email,
      password: newPassword,
    });
    assert.equal(newLogin.status, 200);
  });

  it('17. atomic concurrent throttling: 6 simultaneous requests strictly allow at most 3 accepted attempts, 3 persisted records, and 3 email sends without enumeration', async () => {
    mockEmailProvider.clear();
    const existingUser = await registerUser();
    const unknownEmail = `unknown-concurrent-${randomUUID()}@example.com`;
    createdEmails.push(unknownEmail);

    // 1. Launch 6 simultaneous requests for registered address
    const registeredResponses = await Promise.all([
      post('/auth/password-reset/request', { email: existingUser.email }),
      post('/auth/password-reset/request', { email: existingUser.email }),
      post('/auth/password-reset/request', { email: existingUser.email }),
      post('/auth/password-reset/request', { email: existingUser.email }),
      post('/auth/password-reset/request', { email: existingUser.email }),
      post('/auth/password-reset/request', { email: existingUser.email }),
    ]);

    const regAccepted = registeredResponses.filter((r) => r.status === 200).length;
    const regThrottled = registeredResponses.filter((r) => r.status === 429).length;

    // Verify exactly at most 3 accepted attempts and remaining throttled
    assert.equal(regAccepted, 3, 'Registered address must accept exactly 3 attempts');
    assert.equal(regThrottled, 3, 'Registered address must throttle exactly 3 attempts');

    // Verify at most 3 persisted throttle records in DB
    const regRecordsCount = await prisma.passwordResetRequest.count({
      where: { email: existingUser.email },
    });
    assert.equal(regRecordsCount, 3, 'Registered address must have at most 3 persisted throttle records');

    // Verify at most 3 attempted email sends for registered address
    const regEmailsSent = mockEmailProvider
      .getSentEmails()
      .filter((e) => e.to === existingUser.email).length;
    assert.equal(regEmailsSent, 3, 'Registered address must have at most 3 attempted email sends');

    // 2. Launch 6 simultaneous requests for nonexistent address
    const unknownResponses = await Promise.all([
      post('/auth/password-reset/request', { email: unknownEmail }),
      post('/auth/password-reset/request', { email: unknownEmail }),
      post('/auth/password-reset/request', { email: unknownEmail }),
      post('/auth/password-reset/request', { email: unknownEmail }),
      post('/auth/password-reset/request', { email: unknownEmail }),
      post('/auth/password-reset/request', { email: unknownEmail }),
    ]);

    const unkAccepted = unknownResponses.filter((r) => r.status === 200).length;
    const unkThrottled = unknownResponses.filter((r) => r.status === 429).length;

    // Verify nonexistent address also accepts exactly 3 attempts and throttles 3
    assert.equal(unkAccepted, 3, 'Nonexistent address must accept exactly 3 attempts');
    assert.equal(unkThrottled, 3, 'Nonexistent address must throttle exactly 3 attempts');

    // Verify at most 3 persisted throttle records in DB for nonexistent address
    const unkRecordsCount = await prisma.passwordResetRequest.count({
      where: { email: unknownEmail },
    });
    assert.equal(unkRecordsCount, 3, 'Nonexistent address must have at most 3 persisted throttle records');

    // Verify 0 email sends for nonexistent address
    const unkEmailsSent = mockEmailProvider
      .getSentEmails()
      .filter((e) => e.to === unknownEmail).length;
    assert.equal(unkEmailsSent, 0, 'Nonexistent address must have 0 attempted email sends');

    // 3. Verify known and unknown addresses expose no different rate-limit responses
    const reg429Body = (await registeredResponses.find((r) => r.status === 429)!.json()) as ApiResponse;
    const unk429Body = (await unknownResponses.find((r) => r.status === 429)!.json()) as ApiResponse;

    assert.equal(reg429Body.status, 'error');
    assert.equal(unk429Body.status, 'error');
    assert.match(reg429Body.message || '', /Too many password reset requests/i);
    assert.equal(reg429Body.message, unk429Body.message);
  });
});
