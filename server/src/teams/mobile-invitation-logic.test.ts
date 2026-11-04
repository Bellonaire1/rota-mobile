import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import regex & schema definitions to test logic parity between frontend and backend
import { createInvitationSchema, tokenActionSchema } from '../schemas/team-invitation.schema';

// Import extracted mobile invitation coordinators dynamically to preserve server tsconfig rootDir
const {
  InvitationAcceptanceCoordinator: RawCoordinator,
  PendingTokenManager: RawPendingManager,
  PENDING_INVITATION_STORAGE_KEY,
  PreviewGenerationTracker: RawTracker,
} = require('../../../app/src/services/invitationWorkflow');

const InvitationAcceptanceCoordinator = RawCoordinator as new <T = any>() => any;
const PendingTokenManager = RawPendingManager as new (storage?: any, maxAgeMs?: number) => any;
const PreviewGenerationTracker = RawTracker as new () => any;

interface KeyValueStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  isAvailableAsync?(): Promise<boolean>;
}

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

function createMockStorage(): { storage: Map<string, string>; adapter: KeyValueStorage } {
  const storage = new Map<string, string>();
  const adapter: KeyValueStorage = {
    async getItemAsync(key: string) {
      return storage.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      storage.set(key, value);
    },
    async deleteItemAsync(key: string) {
      storage.delete(key);
    },
    async isAvailableAsync() {
      return true;
    },
  };
  return { storage, adapter };
}

describe('R03.4 & R03.4B: mobile team invitations, deep links and acceptance workflow', () => {
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

  // 3. Email matching and authorization guards
  it('11. validates matching emails with identical casing', () => {
    assert.strictEqual(validateEmailMatch('alice@example.com', 'alice@example.com'), true);
  });

  it('12. validates matching emails with different casing and whitespace', () => {
    assert.strictEqual(
      validateEmailMatch('  Alice.Smith@Example.COM ', 'alice.smith@example.com'),
      true
    );
  });

  it('13. rejects invitation preview/acceptance when authenticated email differs from recipient', () => {
    assert.strictEqual(validateEmailMatch('bob@example.com', 'alice@example.com'), false);
    assert.strictEqual(validateEmailMatch('attacker@phish.com', 'victim@company.com'), false);
  });

  // 4. Backend schema compatibility with mobile client payloads
  it('14. verifies createInvitationSchema accepts email and STAFF/MANAGER role', () => {
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

  it('15. verifies createInvitationSchema rejects OWNER role for invitations', () => {
    assert.throws(
      () => createInvitationSchema.parse({ email: 'owner@example.com', role: 'OWNER' }),
      /Invalid/
    );
  });

  it('16. verifies tokenActionSchema accepts 64-character token', () => {
    const token = 'e'.repeat(64);
    const parsed = tokenActionSchema.parse({ token });
    assert.strictEqual(parsed.token, token);
  });

  it('17. verifies tokenActionSchema trims whitespace from token', () => {
    const token = 'a'.repeat(64);
    const parsed = tokenActionSchema.parse({ token: `  ${token}  ` });
    assert.strictEqual(parsed.token, token);
  });

  it('18. verifies tokenActionSchema rejects empty or truncated tokens', () => {
    assert.throws(() => tokenActionSchema.parse({ token: '' }), /Invalid token length/);
    assert.throws(() => tokenActionSchema.parse({ token: 'short' }), /Invalid token length/);
  });

  it('19. verifies createInvitationSchema strips unrecognized fields like clientBaseUrl', () => {
    const payload = createInvitationSchema.parse({
      email: 'safe@example.com',
      role: 'STAFF',
      clientBaseUrl: 'https://malicious-open-redirect.com',
    } as any);
    assert.strictEqual('clientBaseUrl' in payload, false);
    assert.strictEqual(payload.email, 'safe@example.com');
  });

  // 5. R03.4B Correctness Fixes: Pending Token Lifecycle Tests (A - D)
  it('A. cancel invitation clears persisted token from storage and memory', async () => {
    const { storage, adapter } = createMockStorage();
    const manager = new PendingTokenManager(adapter);

    await manager.saveToken('token_to_cancel');
    assert.strictEqual(await manager.getToken(), 'token_to_cancel');
    assert.ok(storage.has(PENDING_INVITATION_STORAGE_KEY));

    await manager.cancelInvitation();
    assert.strictEqual(await manager.getToken(), null);
    assert.strictEqual(storage.has(PENDING_INVITATION_STORAGE_KEY), false);
  });

  it('B. switching accounts preserves the intended invitation token', async () => {
    const { storage, adapter } = createMockStorage();
    const manager = new PendingTokenManager(adapter);

    await manager.switchAccount('token_switch_account');
    // Token is preserved in both memory and storage for post-auth resumption
    assert.strictEqual(await manager.getToken(), 'token_switch_account');
    const raw = storage.get(PENDING_INVITATION_STORAGE_KEY);
    assert.ok(raw?.includes('token_switch_account'));
    assert.ok(raw?.includes('"forSwitchAccount":true'));
  });

  it('C. new invitation replaces an old pending token in storage', async () => {
    const { adapter } = createMockStorage();
    const manager = new PendingTokenManager(adapter);

    await manager.saveToken('old_token_111');
    assert.strictEqual(await manager.getToken(), 'old_token_111');

    await manager.saveToken('new_token_222');
    assert.strictEqual(await manager.getToken(), 'new_token_222');
  });

  it('D. unrelated login is not redirected by an abandoned/expired token', async () => {
    const { adapter } = createMockStorage();
    // 50ms TTL to simulate an abandoned token from days ago
    const manager = new PendingTokenManager(adapter, 50);

    await manager.saveToken('abandoned_token');
    assert.strictEqual(await manager.getToken(), 'abandoned_token');

    // Wait past expiration
    await new Promise((r) => setTimeout(r, 70));

    // Unrelated login checks pending token: returns null and purges storage
    const token = await manager.getToken();
    assert.strictEqual(token, null, 'Expired/abandoned token must return null');
  });

  // 6. R03.4B Correctness Fixes: Stale Preview Responses (E - F)
  it('E. token A response cannot overwrite token B preview when token changes', () => {
    const tracker = new PreviewGenerationTracker();

    const genA = tracker.startRequest('tokenA', 'user1');
    assert.strictEqual(genA, 1);

    // User switches to token B while token A request is still in-flight
    const genB = tracker.startRequest('tokenB', 'user1');
    assert.strictEqual(genB, 2);

    // Token A response arrives late: must be rejected
    const isCurrentA = tracker.isCurrent(genA, 'tokenA', 'user1');
    assert.strictEqual(isCurrentA, false, 'Stale token A response must be rejected');

    // Token B response arrives: must be accepted
    const isCurrentB = tracker.isCurrent(genB, 'tokenB', 'user1');
    assert.strictEqual(isCurrentB, true, 'Fresh token B response must be accepted');
  });

  it('F. previous-account preview cannot overwrite current-account state', () => {
    const tracker = new PreviewGenerationTracker();

    const gen = tracker.startRequest('tokenA', 'user_alice');

    // User switches accounts to Bob while preview is in-flight
    const isCurrentForAlice = tracker.isCurrent(gen, 'tokenA', 'user_alice');
    assert.strictEqual(isCurrentForAlice, true);

    const isCurrentForBob = tracker.isCurrent(gen, 'tokenA', 'user_bob');
    assert.strictEqual(
      isCurrentForBob,
      false,
      'Response for previous user must not be accepted for current user'
    );
  });

  // 7. R03.4B Correctness Fixes: Acceptance Success & Team Sync (G - K)
  it('G. accepted invitation does not trigger duplicate acceptance API calls', async () => {
    const coordinator = new InvitationAcceptanceCoordinator();
    let acceptCallCount = 0;

    const acceptFn = async () => {
      acceptCallCount++;
      return { team: { id: 'team_xyz', name: 'Alpha Team' } };
    };
    const listTeamsFn = async () => ({
      teams: [{ id: 'team_xyz', name: 'Alpha Team' }],
    });
    const selectTeamFn = async () => {};

    // First acceptance
    const res1 = await coordinator.acceptAndSync({
      token: 'tok_g',
      acceptFn,
      listTeamsFn,
      selectTeamFn,
      getTeamId: (t: any) => t.id,
      onComplete: () => {},
    });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(acceptCallCount, 1);

    // Second call: coordinator already holds acceptedTeamId, does not re-invoke acceptFn
    const res2 = await coordinator.acceptAndSync({
      token: 'tok_g',
      acceptFn,
      listTeamsFn,
      selectTeamFn,
      getTeamId: (t: any) => t.id,
      onComplete: () => {},
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(acceptCallCount, 1, 'Acceptance endpoint must not be called twice');
  });

  it('H. failed post-accept team refresh does not fabricate a team object', async () => {
    const coordinator = new InvitationAcceptanceCoordinator();
    let selectedTeam: any = null;

    const acceptFn = async () => ({ team: { id: 'team_new', name: 'New Team' } });
    // listTeamsFn fails / returns empty list
    const listTeamsFn = async () => ({ teams: [] });
    const selectTeamFn = async (t: any) => {
      selectedTeam = t;
    };

    const res = await coordinator.acceptAndSync({
      token: 'tok_h',
      acceptFn,
      listTeamsFn,
      selectTeamFn,
      getTeamId: (t: any) => t.id,
      onComplete: () => {},
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.accepted, true);
    assert.strictEqual(res.syncFailed, true);
    assert.strictEqual(selectedTeam, null, 'Must NOT fabricate a fallback team');
    assert.ok(coordinator.getSyncError()?.includes('not yet visible'));
  });

  it('I. team-list retry can recover after acceptance without re-calling accept', async () => {
    const coordinator = new InvitationAcceptanceCoordinator();
    let selectedTeam: any = null;
    let acceptCallCount = 0;
    let completed = false;

    const acceptFn = async () => {
      acceptCallCount++;
      return { team: { id: 'team_recovered', name: 'Recovered Team' } };
    };

    // Step 1: Initial sync fails
    await coordinator.acceptAndSync({
      token: 'tok_i',
      acceptFn,
      listTeamsFn: async () => ({ teams: [] }),
      selectTeamFn: async (t: any) => {
        selectedTeam = t;
      },
      getTeamId: (t: any) => t.id,
      onComplete: () => {},
    });

    assert.strictEqual(coordinator.isSyncFailed(), true);
    assert.strictEqual(acceptCallCount, 1);

    // Step 2: Retry sync succeeds
    const retryRes = await coordinator.retrySync({
      listTeamsFn: async () => ({
        teams: [{ id: 'team_recovered', name: 'Recovered Team' }],
      }),
      selectTeamFn: async (t: any) => {
        selectedTeam = t;
      },
      getTeamId: (t: any) => t.id,
      onComplete: () => {
        completed = true;
      },
    });

    assert.strictEqual(retryRes.success, true);
    assert.strictEqual(completed, true);
    assert.strictEqual(selectedTeam?.id, 'team_recovered');
    assert.strictEqual(acceptCallCount, 1, 'Retry must not call accept API again');
  });

  it('J. successful team refresh selects the real server team and completes navigation', async () => {
    const coordinator = new InvitationAcceptanceCoordinator();
    let selectedTeam: any = null;
    let navigated = false;

    const serverTeam = {
      id: 'team_real',
      name: 'Real Production Team',
      createdByUserId: 'user_owner_123',
      createdAt: '2026-11-04T12:00:00Z',
    };

    const res = await coordinator.acceptAndSync({
      token: 'tok_j',
      acceptFn: async () => ({ team: { id: 'team_real', name: 'Real Production Team' } }),
      listTeamsFn: async () => ({ teams: [serverTeam] }),
      selectTeamFn: async (t: any) => {
        selectedTeam = t;
      },
      getTeamId: (t: any) => t.id,
      onComplete: () => {
        navigated = true;
      },
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(selectedTeam, serverTeam, 'Selected team must be the actual server team');
    assert.strictEqual(selectedTeam.createdByUserId, 'user_owner_123');
    assert.strictEqual(navigated, true);
  });

  it('K. rapid duplicate button taps cannot create parallel acceptance calls', async () => {
    const coordinator = new InvitationAcceptanceCoordinator();
    let inFlight = 0;
    let peakConcurrency = 0;
    let acceptCallCount = 0;

    const slowAcceptFn = async () => {
      acceptCallCount++;
      inFlight++;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return { team: { id: 'team_rapid', name: 'Rapid Team' } };
    };

    const listTeamsFn = async () => ({
      teams: [{ id: 'team_rapid', name: 'Rapid Team' }],
    });
    const selectTeamFn = async () => {};

    // Dispatch two calls almost simultaneously (simulating rapid double-tap)
    const [call1, call2] = await Promise.all([
      coordinator.acceptAndSync({
        token: 'tok_k',
        acceptFn: slowAcceptFn,
        listTeamsFn,
        selectTeamFn,
        getTeamId: (t: any) => t.id,
        onComplete: () => {},
      }),
      coordinator.acceptAndSync({
        token: 'tok_k',
        acceptFn: slowAcceptFn,
        listTeamsFn,
        selectTeamFn,
        getTeamId: (t: any) => t.id,
        onComplete: () => {},
      }),
    ]);

    assert.strictEqual(acceptCallCount, 1, 'Must only execute acceptFn once');
    assert.strictEqual(peakConcurrency, 1, 'Accept calls must never run concurrently');
    assert.ok(
      (call1.success && !call2.success) || (!call1.success && call2.success),
      'Second tap must be locked out'
    );
  });
});
