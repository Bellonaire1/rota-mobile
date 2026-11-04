import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';
import { mockEmailProvider, emailService, escapeHtml, resolveTrustedWebUrl } from '../services/email';
import { ActivityEventType, TeamRole } from '@prisma/client';

interface AuthResponse {
  user?: { id: string; email: string; name?: string | null };
  accessToken?: string;
}

interface TeamResponse {
  team?: { id: string; name: string };
}

interface InvitationResponse {
  invitation?: {
    id: string;
    teamId: string;
    invitedEmail: string;
    role: string;
    status: string;
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string | null;
    revokedAt?: string | null;
  };
  invitations?: Array<{
    id: string;
    teamId: string;
    invitedEmail: string;
    role: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }>;
}

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, options);

const register = async (email?: string, name = 'Test User'): Promise<AuthResponse> => {
  const userEmail = email ?? `hardening-user-${randomUUID()}@example.com`;
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
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

const createTeam = async (auth: AuthResponse, name = 'Hardening Team') => {
  const response = await jsonRequest('/teams', auth.accessToken, { name });
  const body = (await response.json()) as TeamResponse;
  createdTeamIds.push(body.team!.id);
  return body.team!.id;
};

const extractTokenFromEmail = (text: string): string => {
  const match = text.match(/token=([a-f0-9]{64})/i) || text.match(/([a-f0-9]{64})/);
  assert.ok(match, 'Token must be present in invitation email text');
  return match[1];
};

const skipReason = authIntegrationSkipReason();

describe('R03.3B: targeted team invitation security hardening', { concurrency: false, skip: skipReason }, () => {
  before(async () => {
    if (skipReason) return;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    mockEmailProvider.clear();
  });

  after(async () => {
    if (skipReason) return;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    if (createdTeamIds.length > 0) {
      await prisma.billingSubscription.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamInvitation.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.activityEvent.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.teamMembership.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => {});
      await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // A. No placeholder URL in invitation emails
  it('A. does not present any placeholder URL (app.rota.example.com) in invitation emails', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'No Placeholder Team');
    const targetEmail = `no-placeholder-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail();
    assert.ok(sentEmail, 'Email must have been sent');
    assert.ok(sentEmail.html, 'Email HTML must be present');
    assert.strictEqual(sentEmail.text.includes('app.rota.example.com'), false, 'Text email must not contain placeholder URL');
    assert.strictEqual(sentEmail.html!.includes('app.rota.example.com'), false, 'HTML email must not contain placeholder URL');
    assert.strictEqual(sentEmail.html!.includes('example.com/invite'), false, 'HTML email must not contain example.com invite link');
  });

  // B. Valid rota:// invitation deep link
  it('B. includes a valid rota:// invitation deep link and manual code', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Deep Link Team');
    const targetEmail = `deep-link-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail()!;
    assert.ok(sentEmail.html, 'Email HTML must be present');
    assert.match(sentEmail.text, /rota:\/\/invite\?token=[a-f0-9]{64}/);
    assert.match(sentEmail.html!, /href="rota:\/\/invite\?token=[a-f0-9]{64}"/);
    assert.match(sentEmail.html!, /<code[^>]*>[a-f0-9]{64}<\/code>/);
  });

  // C. Invalid web fallback rejected or omitted
  it('C. rejects dangerous or insecure web fallbacks and omits placeholders', async () => {
    // 1. Dangerous scheme rejected
    assert.throws(
      () => resolveTrustedWebUrl('javascript:alert(1)'),
      /Dangerous URL scheme rejected: javascript:/
    );
    assert.throws(
      () => resolveTrustedWebUrl('data:text/html,malicious'),
      /Dangerous URL scheme rejected: data:/
    );
    assert.throws(
      () => resolveTrustedWebUrl('file:///etc/passwd'),
      /Dangerous URL scheme rejected: file:/
    );

    // 2. Insecure non-HTTPS scheme rejected for non-localhost
    assert.throws(
      () => resolveTrustedWebUrl('http://insecure-domain.com/rota'),
      /Insecure web fallback URL scheme: http:/
    );

    // 3. Placeholder domains omitted (returns null)
    assert.strictEqual(resolveTrustedWebUrl('https://app.rota.example.com'), null);
    assert.strictEqual(resolveTrustedWebUrl('https://example.com/invite'), null);
    assert.strictEqual(resolveTrustedWebUrl(undefined), null);
    assert.strictEqual(resolveTrustedWebUrl(''), null);

    // 4. Valid HTTPS custom portal accepted
    const trusted = resolveTrustedWebUrl('https://portal.mycompany.org/app/');
    assert.strictEqual(trusted, 'https://portal.mycompany.org/app');
  });

  // D. HTML injection in team name safely encoded
  it('D. safely encodes HTML injection in team names', async () => {
    const owner = await register();
    const maliciousTeamName = '<script>alert("team-xss")</script> & "Dangerous"';
    const teamId = await createTeam(owner, maliciousTeamName);
    const targetEmail = `xss-team-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail()!;
    assert.ok(sentEmail.html, 'Email HTML must be present');
    assert.strictEqual(sentEmail.html!.includes('<script>'), false, 'HTML markup must not contain unescaped <script>');
    assert.ok(sentEmail.html!.includes('&lt;script&gt;alert(&quot;team-xss&quot;)&lt;/script&gt; &amp; &quot;Dangerous&quot;'));
  });

  // E. HTML injection in inviter name safely encoded
  it('E. safely encodes HTML injection in inviter name', async () => {
    const maliciousInviterName = '"><img src=x onerror=alert(1)> & \'Admin\'';
    const owner = await register(`inviter-xss-${randomUUID()}@example.com`, maliciousInviterName);
    const teamId = await createTeam(owner, 'Inviter XSS Team');
    const targetEmail = `xss-inviter-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail()!;
    assert.ok(sentEmail.html, 'Email HTML must be present');
    assert.strictEqual(sentEmail.html!.includes('<img src=x'), false, 'HTML markup must not contain unescaped <img>');
    assert.ok(sentEmail.html!.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;Admin&#39;'));
  });

  // F. Normal invitation email still readable
  it('F. keeps normal invitation emails clear, readable, and structured', async () => {
    const owner = await register(undefined, 'Sarah Connor');
    const teamId = await createTeam(owner, 'Resistance HQ');
    const targetEmail = `readable-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail()!;
    assert.ok(sentEmail.html, 'Email HTML must be present');
    assert.ok(sentEmail.text.includes('Sarah Connor has invited you to join "Resistance HQ" on Rota as a MANAGER.'));
    assert.ok(sentEmail.text.includes('ROTA MOBILE APP (RECOMMENDED)'));
    assert.ok(sentEmail.text.includes('This invitation will expire in 7 days.'));
    assert.ok(sentEmail.html!.includes('Resistance HQ'));
    assert.ok(sentEmail.html!.includes('MANAGER'));
    assert.strictEqual(sentEmail.subject, 'Invitation to join Resistance HQ on Rota');
  });

  // F2. Strips caller-supplied clientBaseUrl and rejects open-redirect poisoning
  it('F2. ignores or strips caller-supplied clientBaseUrl so untrusted redirect domains cannot poison email', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Phish Defense Team');
    const targetEmail = `phish-defense-${randomUUID()}@example.com`;

    const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
      clientBaseUrl: 'https://evil-phishing-site.attacker.com/steal-token',
    });
    assert.strictEqual(res.status, 201);

    const sentEmail = mockEmailProvider.getLastEmail()!;
    assert.ok(sentEmail, 'Email must have been sent');
    assert.strictEqual(
      sentEmail.text.includes('evil-phishing-site.attacker.com'),
      false,
      'Email text must not contain caller-supplied phishing URL'
    );
    assert.strictEqual(
      sentEmail.html!.includes('evil-phishing-site.attacker.com'),
      false,
      'Email HTML must not contain caller-supplied phishing URL'
    );
  });

  // G. 10 concurrent invitation attempts respect the limit
  it('G. allows exactly 10 concurrent invitation attempts across unique recipients', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Concurrency 10 Team');

    // Launch 10 concurrent invitations for different emails
    const emails = Array.from({ length: 10 }, (_, i) => `concurrent-10-${i}-${randomUUID()}@example.com`);
    const promises = emails.map((email) =>
      jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
        email,
        role: 'STAFF',
      })
    );

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);
    assert.deepStrictEqual(statuses, Array(10).fill(201), 'All 10 concurrent invitations must succeed with 201');

    const dbCount = await prisma.teamInvitation.count({
      where: { teamId },
    });
    assert.strictEqual(dbCount, 10, 'Database must record exactly 10 invitations');
  });

  // H. An additional request receives HTTP 429
  it('H. rejects an 11th invitation attempt with HTTP 429 Too Many Requests', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Limit 429 Team');

    // Send 10 invitations
    for (let i = 0; i < 10; i++) {
      const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
        email: `batch-user-${i}-${randomUUID()}@example.com`,
        role: 'STAFF',
      });
      assert.strictEqual(res.status, 201);
    }

    // 11th attempt
    const res11 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: `eleventh-user-${randomUUID()}@example.com`,
      role: 'STAFF',
    });
    assert.strictEqual(res11.status, 429, '11th invitation attempt within sliding window must return HTTP 429');
    const body = (await res11.json()) as any;
    assert.match(body.message, /too many invitations/i);
  });

  // I. Concurrent duplicate email invitations create at most one active invitation
  it('I. creates at most one active invitation under concurrent duplicate creation requests', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Concurrent Duplicate Team');
    const duplicateEmail = `race-email-${randomUUID()}@example.com`;

    // Fire 5 simultaneous creation requests for the exact same email
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
          email: duplicateEmail,
          role: 'STAFF',
        })
      )
    );

    const statuses = responses.map((r) => r.status).sort();
    assert.strictEqual(statuses.filter((s) => s === 201).length, 1, 'Exactly one request must return 201');
    assert.strictEqual(statuses.filter((s) => s === 409).length, 4, 'Remaining 4 requests must return 409 Conflict');

    // Confirm database uniqueness
    const activeInvites = await prisma.teamInvitation.findMany({
      where: {
        teamId,
        invitedEmail: duplicateEmail,
        acceptedAt: null,
        revokedAt: null,
      },
    });
    assert.strictEqual(activeInvites.length, 1, 'Exactly one active invitation must exist in PostgreSQL');
  });

  // J. Duplicate conflict returns HTTP 409
  it('J. returns HTTP 409 Conflict (not HTTP 500) on sequential duplicate invitation', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Sequential Duplicate Team');
    const email = `sequential-dup-${randomUUID()}@example.com`;

    const res1 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email,
      role: 'STAFF',
    });
    assert.strictEqual(res1.status, 201);

    const res2 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email,
      role: 'STAFF',
    });
    assert.strictEqual(res2.status, 409, 'Duplicate invitation must return HTTP 409');
    const body = (await res2.json()) as any;
    assert.match(body.message, /active invitation already exists/i);
  });

  // K. Failed dispatch does not bypass rate limiting
  it('K. counts failed dispatch attempts toward rate limit without resetting throttle', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Failed Dispatch Team');

    // Temporarily cause email provider to throw delivery error
    const originalSend = mockEmailProvider.send.bind(mockEmailProvider);
    mockEmailProvider.send = async () => {
      throw new Error('Simulated upstream SMTP connection reset');
    };

    try {
      // Perform 10 failed invitation attempts
      for (let i = 0; i < 10; i++) {
        const res = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
          email: `fail-email-${i}-${randomUUID()}@example.com`,
          role: 'STAFF',
        });
        assert.strictEqual(res.status, 500, `Attempt ${i} must fail with HTTP 500 email delivery error`);
      }

      // Verify all 10 attempts are preserved with revokedAt set
      const dbAttempts = await prisma.teamInvitation.count({
        where: { teamId, revokedAt: { not: null } },
      });
      assert.strictEqual(dbAttempts, 10, 'All 10 failed attempts must be recorded as revoked');

      // 11th attempt - even after restoring email provider - must be blocked by rate limit
      mockEmailProvider.send = originalSend;

      const res11 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
        email: `attempt-11-${randomUUID()}@example.com`,
        role: 'STAFF',
      });
      assert.strictEqual(res11.status, 429, '11th attempt must be rejected with HTTP 429 despite previous delivery failures');
    } finally {
      mockEmailProvider.send = originalSend;
    }
  });

  // L. Expired invitation can be re-invited safely
  it('L. allows re-inviting an email after previous invitation expired', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Expired Re-Invite Team');
    const targetEmail = `expired-user-${randomUUID()}@example.com`;

    // Create initial invitation
    const res1 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(res1.status, 201);
    const body1 = (await res1.json()) as InvitationResponse;
    const invId1 = body1.invitation!.id;

    // Simulate expiration in database
    await prisma.teamInvitation.update({
      where: { id: invId1 },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    // Create new invitation for the same email
    const res2 = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'MANAGER',
    });
    assert.strictEqual(res2.status, 201, 'Re-invitation after expiration must succeed with 201');
    const body2 = (await res2.json()) as InvitationResponse;
    assert.strictEqual(body2.invitation!.role, 'MANAGER');

    // Confirm old invitation is marked revoked and new invitation is active
    const oldInv = await prisma.teamInvitation.findUnique({ where: { id: invId1 } });
    assert.ok(oldInv?.revokedAt !== null, 'Old expired invitation must have revokedAt set');

    const newInv = await prisma.teamInvitation.findUnique({ where: { id: body2.invitation!.id } });
    assert.strictEqual(newInv?.revokedAt, null, 'New invitation must be active');
    assert.strictEqual(newInv?.acceptedAt, null);
  });

  // M. Existing invitation acceptance still works
  it('M. verifies end-to-end invitation acceptance and membership creation', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Acceptance Flow Team');
    const targetEmail = `accept-flow-${randomUUID()}@example.com`;

    const createRes = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    assert.strictEqual(createRes.status, 201);

    const token = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const recipient = await register(targetEmail);

    const acceptRes = await jsonRequest('/team-invitations/accept', recipient.accessToken, {
      token,
    });
    assert.strictEqual(acceptRes.status, 200, 'Acceptance must return HTTP 200');

    // Confirm membership exists
    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: recipient.user!.id } },
    });
    assert.ok(membership, 'Membership record must exist in PostgreSQL');
    assert.strictEqual(membership.role, 'STAFF');
  });

  // N. Raw tokens remain excluded from API responses and database plaintext fields
  it('N. ensures raw tokens never appear in API responses or plaintext database columns', async () => {
    const owner = await register();
    const teamId = await createTeam(owner, 'Token Security Team');
    const targetEmail = `token-sec-${randomUUID()}@example.com`;

    const createRes = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, {
      email: targetEmail,
      role: 'STAFF',
    });
    const createBody = (await createRes.json()) as any;
    assert.strictEqual('token' in createBody.invitation, false, 'Raw token must not be in create response');
    assert.strictEqual('tokenHash' in createBody.invitation, false, 'tokenHash must not be in create response');

    const listRes = await jsonRequest(`/teams/${teamId}/invitations`, owner.accessToken, undefined, 'GET');
    const listBody = (await listRes.json()) as any;
    for (const inv of listBody.invitations) {
      assert.strictEqual('token' in inv, false, 'Raw token must not be in list response');
      assert.strictEqual('tokenHash' in inv, false, 'tokenHash must not be in list response');
    }

    const rawToken = extractTokenFromEmail(mockEmailProvider.getLastEmail()!.text);
    const recipient = await register(targetEmail);

    const previewRes = await jsonRequest('/team-invitations/preview', recipient.accessToken, {
      token: rawToken,
    });
    const previewBody = (await previewRes.json()) as any;
    assert.strictEqual('token' in previewBody.invitation, false, 'Raw token must not be in preview response');
    assert.strictEqual('tokenHash' in previewBody.invitation, false, 'tokenHash must not be in preview response');

    // Inspect database record directly
    const dbInvitation = await prisma.teamInvitation.findFirst({
      where: { teamId, invitedEmail: targetEmail },
    });
    assert.ok(dbInvitation, 'Invitation must exist in DB');
    assert.strictEqual(dbInvitation.tokenHash.length, 64, 'tokenHash must be 64-char SHA-256');
    assert.strictEqual(
      dbInvitation.tokenHash,
      createHash('sha256').update(rawToken).digest('hex'),
      'tokenHash must match SHA-256 digest of raw token'
    );
  });
});
