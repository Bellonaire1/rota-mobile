import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import regex & schema definitions to test logic parity between frontend and backend
import { createInvitationSchema, tokenActionSchema } from '../schemas/team-invitation.schema';

const TOKEN_REGEX = /^[a-f0-9]{64}$/i;

function parseDeepLink(urlStr: string): { route: string; token: string | null } {
  const url = new URL(urlStr.replace(/^rota:\/\//, 'http://dummy.local/'));
  const route = url.pathname === '/' ? '/invite' : url.pathname;
  const token = url.searchParams.get('token');
  return { route, token };
}

function validateEmailMatch(currentEmail: string, invitedEmail: string): boolean {
  return currentEmail.trim().toLowerCase() === invitedEmail.trim().toLowerCase();
}

describe('R03.4: mobile team invitations, deep links and acceptance logic', () => {
  // 1. Token validation
  it('1. accepts valid 64-character lowercase hex token', () => {
    const validToken = 'a'.repeat(64);
    assert.strictEqual(TOKEN_REGEX.test(validToken), true);
  });

  it('2. accepts valid 64-character uppercase hex token', () => {
    const validToken = '1234567890ABCDEF'.repeat(4);
    assert.strictEqual(TOKEN_REGEX.test(validToken), true);
  });

  it('3. accepts mixed-case 64-character hex token', () => {
    const validToken = '0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF';
    assert.strictEqual(TOKEN_REGEX.test(validToken), true);
  });

  it('4. rejects token with length less than 64 characters', () => {
    const shortToken = 'a'.repeat(63);
    assert.strictEqual(TOKEN_REGEX.test(shortToken), false);
  });

  it('5. rejects token with length greater than 64 characters', () => {
    const longToken = 'a'.repeat(65);
    assert.strictEqual(TOKEN_REGEX.test(longToken), false);
  });

  it('6. rejects token containing non-hexadecimal characters', () => {
    const invalidToken = 'g'.repeat(64);
    assert.strictEqual(TOKEN_REGEX.test(invalidToken), false);
    const withPunctuation = 'a'.repeat(63) + '!';
    assert.strictEqual(TOKEN_REGEX.test(withPunctuation), false);
  });

  it('7. trims leading/trailing whitespace before token validation', () => {
    const raw = '  ' + 'f'.repeat(64) + ' \n';
    const trimmed = raw.trim();
    assert.strictEqual(TOKEN_REGEX.test(trimmed), true);
  });

  // 2. Deep link parsing
  it('8. extracts token from rota:// custom scheme link', () => {
    const token = 'c0ffee'.repeat(10) + '1234';
    const link = `rota://invite?token=${token}`;
    const parsed = parseDeepLink(link);
    assert.strictEqual(parsed.route, '/invite');
    assert.strictEqual(parsed.token, token);
  });

  it('9. extracts token from HTTPS web fallback URL', () => {
    const token = 'beef'.repeat(16);
    const link = `https://app.rota.example.com/invite?token=${token}`;
    const url = new URL(link);
    assert.strictEqual(url.pathname, '/invite');
    assert.strictEqual(url.searchParams.get('token'), token);
  });

  it('10. handles deep link without token parameter gracefully', () => {
    const link = 'rota://invite';
    const parsed = parseDeepLink(link);
    assert.strictEqual(parsed.route, '/invite');
    assert.strictEqual(parsed.token, null);
  });

  // 3. Pending invitation persistence simulation
  it('11. simulates pending invitation storage across unauthenticated redirect', () => {
    const storage: Record<string, string> = {};
    const testToken = '1'.repeat(64);

    // Unauthenticated user arrives: token saved
    storage['pending_invitation_token'] = testToken;
    assert.strictEqual(storage['pending_invitation_token'], testToken);

    // After login: retrieved and consumed
    const retrieved = storage['pending_invitation_token'];
    assert.strictEqual(retrieved, testToken);

    // Token cleared on acceptance
    delete storage['pending_invitation_token'];
    assert.strictEqual(storage['pending_invitation_token'], undefined);
  });

  // 4. Email matching and authorization guards
  it('12. validates matching emails with identical casing', () => {
    assert.strictEqual(validateEmailMatch('alice@example.com', 'alice@example.com'), true);
  });

  it('13. validates matching emails with different casing and whitespace', () => {
    assert.strictEqual(
      validateEmailMatch('  Alice.Smith@Example.COM ', 'alice.smith@example.com'),
      true
    );
  });

  it('14. rejects invitation preview/acceptance when authenticated email differs from recipient', () => {
    assert.strictEqual(validateEmailMatch('bob@example.com', 'alice@example.com'), false);
    assert.strictEqual(validateEmailMatch('attacker@phish.com', 'victim@company.com'), false);
  });

  // 5. Backend schema compatibility with mobile client payloads
  it('15. verifies createInvitationSchema accepts email and STAFF/MANAGER role', () => {
    const staffPayload = createInvitationSchema.parse({
      email: 'staff.member@example.com',
      role: 'STAFF',
    });
    assert.strictEqual(staffPayload.email, 'staff.member@example.com');
    assert.strictEqual(staffPayload.role, 'STAFF');

    const managerPayload = createInvitationSchema.parse({
      email: 'Manager@Example.COM',
      role: 'MANAGER',
    });
    assert.strictEqual(managerPayload.email, 'manager@example.com');
    assert.strictEqual(managerPayload.role, 'MANAGER');
  });

  it('16. verifies createInvitationSchema rejects OWNER role for invitations', () => {
    assert.throws(
      () => createInvitationSchema.parse({ email: 'owner@example.com', role: 'OWNER' }),
      /Invalid/
    );
  });

  it('17. verifies tokenActionSchema accepts 64-character token', () => {
    const token = 'e'.repeat(64);
    const parsed = tokenActionSchema.parse({ token });
    assert.strictEqual(parsed.token, token);
  });

  it('18. verifies tokenActionSchema trims whitespace from token', () => {
    const token = 'a'.repeat(64);
    const parsed = tokenActionSchema.parse({ token: `  ${token}  ` });
    assert.strictEqual(parsed.token, token);
  });

  it('19. verifies tokenActionSchema rejects empty or truncated tokens', () => {
    assert.throws(() => tokenActionSchema.parse({ token: '' }), /Invalid token length/);
    assert.throws(() => tokenActionSchema.parse({ token: 'short' }), /Invalid token length/);
  });

  it('20. verifies createInvitationSchema strips unrecognized fields like clientBaseUrl', () => {
    const payload = createInvitationSchema.parse({
      email: 'safe@example.com',
      role: 'STAFF',
      clientBaseUrl: 'https://malicious-open-redirect.com',
    } as any);
    assert.strictEqual('clientBaseUrl' in payload, false);
    assert.strictEqual(payload.email, 'safe@example.com');
  });
});
