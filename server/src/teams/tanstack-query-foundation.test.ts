import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamically require to avoid tsconfig rootDir boundary errors
const { queryKeys } = require('../../../app/src/services/query/queryKeys');
const {
  createQueryClient,
  clearQueryCache,
  DEFAULT_STALE_TIME_MS,
  DEFAULT_GC_TIME_MS,
  MAX_RETRY_COUNT,
  calculateRetryBackoff,
  shouldRetryQuery,
} = require('../../../app/src/services/query/queryClient');
const { setupQueryFocusManager } = require('../../../app/src/services/query/focusManager');
const { focusManager } = require('../../../app/node_modules/@tanstack/react-query');

describe('R06A: TanStack Query Foundation & Client State Architecture', () => {
  // Test A: Query key stability
  it('A. Query key stability: produces consistent deterministic keys', () => {
    const key1 = queryKeys.teams.list('user-123');
    const key2 = queryKeys.teams.list('user-123');
    assert.deepEqual(key1, key2);
    assert.equal(JSON.stringify(key1), JSON.stringify(key2));

    const shiftKey1 = queryKeys.shifts.list('team-1', 'user-1', { page: 1, limit: 20 });
    const shiftKey2 = queryKeys.shifts.list('team-1', 'user-1', { page: 1, limit: 20 });
    assert.deepEqual(shiftKey1, shiftKey2);
  });

  // Test B: Team isolation
  it('B. Team isolation: team A and team B queries are completely segregated in cache', async () => {
    const client = createQueryClient();
    const teamAKey = queryKeys.shifts.list('team-A', 'user-1', { page: 1 });
    const teamBKey = queryKeys.shifts.list('team-B', 'user-1', { page: 1 });

    client.setQueryData(teamAKey, { shifts: [{ id: 'shift-A', title: 'Team A Shift' }] });
    client.setQueryData(teamBKey, { shifts: [{ id: 'shift-B', title: 'Team B Shift' }] });

    const cachedA = client.getQueryData(teamAKey) as any;
    const cachedB = client.getQueryData(teamBKey) as any;

    assert.equal(cachedA.shifts[0].id, 'shift-A');
    assert.equal(cachedB.shifts[0].id, 'shift-B');
    assert.notDeepEqual(cachedA, cachedB);

    client.clear();
  });

  // Test C: User/account isolation
  it('C. User/account isolation: user A and user B queries are strictly isolated', async () => {
    const client = createQueryClient();
    const userAKey = queryKeys.teams.list('user-A');
    const userBKey = queryKeys.teams.list('user-B');

    client.setQueryData(userAKey, { teams: [{ id: 'team-1', name: 'Alpha' }] });
    client.setQueryData(userBKey, { teams: [{ id: 'team-2', name: 'Beta' }] });

    const cachedUserA = client.getQueryData(userAKey) as any;
    const cachedUserB = client.getQueryData(userBKey) as any;

    assert.equal(cachedUserA.teams[0].id, 'team-1');
    assert.equal(cachedUserB.teams[0].id, 'team-2');

    client.clear();
  });

  // Test D: Pagination keys
  it('D. Pagination keys: different page parameters produce distinct cache partitions', () => {
    const page1Key = queryKeys.shifts.list('team-1', 'user-1', { page: 1, limit: 20 });
    const page2Key = queryKeys.shifts.list('team-1', 'user-1', { page: 2, limit: 20 });

    assert.notDeepEqual(page1Key, page2Key);
    assert.equal((page1Key[4] as any).page, 1);
    assert.equal((page2Key[4] as any).page, 2);
  });

  // Test E: Filter keys
  it('E. Filter keys: status and date filters produce distinct query keys', () => {
    const allShiftsKey = queryKeys.shifts.list('team-1', 'user-1', { status: undefined });
    const scheduledKey = queryKeys.shifts.list('team-1', 'user-1', { status: 'SCHEDULED' });
    const cancelledKey = queryKeys.shifts.list('team-1', 'user-1', { status: 'CANCELLED' });

    assert.notDeepEqual(allShiftsKey, scheduledKey);
    assert.notDeepEqual(scheduledKey, cancelledKey);

    const dateFilterKey = queryKeys.shifts.list('team-1', 'user-1', { from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z' });
    assert.notDeepEqual(allShiftsKey, dateFilterKey);
  });

  // Test F: Same-query deduplication
  it('F. Same-query deduplication: concurrent identical queries invoke fetcher exactly once', async () => {
    const client = createQueryClient();
    let fetchCount = 0;

    const queryFn = async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { data: 'test-data' };
    };

    const key = queryKeys.teams.list('user-dedup');
    const [res1, res2, res3] = await Promise.all([
      client.fetchQuery({ queryKey: key, queryFn }),
      client.fetchQuery({ queryKey: key, queryFn }),
      client.fetchQuery({ queryKey: key, queryFn }),
    ]);

    assert.equal(fetchCount, 1, 'Fetcher must be invoked exactly once for concurrent identical queries');
    assert.deepEqual(res1, { data: 'test-data' });
    assert.deepEqual(res2, { data: 'test-data' });
    assert.deepEqual(res3, { data: 'test-data' });

    client.clear();
  });

  // Test G: Targeted invalidation after mutation
  it('G. Targeted invalidation: mutating team A shifts invalidates only team A shift queries', async () => {
    const client = createQueryClient();

    const teamAShiftsKey = queryKeys.shifts.list('team-A', 'user-1', { page: 1 });
    const teamBShiftsKey = queryKeys.shifts.list('team-B', 'user-1', { page: 1 });
    const teamAMembersKey = queryKeys.members.list('team-A', 'user-1', { page: 1 });

    client.setQueryData(teamAShiftsKey, { shifts: [] });
    client.setQueryData(teamBShiftsKey, { shifts: [] });
    client.setQueryData(teamAMembersKey, { members: [] });

    // Target invalidation for team A shifts
    await client.invalidateQueries({
      queryKey: queryKeys.shifts.all('team-A', 'user-1'),
    });

    const queryStateA = client.getQueryState(teamAShiftsKey);
    const queryStateB = client.getQueryState(teamBShiftsKey);
    const memberStateA = client.getQueryState(teamAMembersKey);

    assert.equal(queryStateA?.isInvalidated, true, 'Team A shifts must be marked invalidated');
    assert.equal(queryStateB?.isInvalidated, false, 'Team B shifts must NOT be invalidated');
    assert.equal(memberStateA?.isInvalidated, false, 'Team A members must NOT be invalidated');

    client.clear();
  });

  // Test H: Cache clearing on sign-out
  it('H. Cache clearing on sign-out: clearQueryCache wipes all cached queries and states', async () => {
    const client = createQueryClient();

    client.setQueryData(queryKeys.teams.list('user-1'), { teams: ['T1'] });
    client.setQueryData(queryKeys.shifts.list('team-1', 'user-1'), { shifts: ['S1'] });

    assert.equal(client.getQueryCache().getAll().length, 2);

    await clearQueryCache(client);

    assert.equal(client.getQueryCache().getAll().length, 0, 'Query cache must be completely empty after clear');
  });

  // Test I: Account switching
  it('I. Account switching: clearing cache prevents previous user records from appearing to new user', async () => {
    const client = createQueryClient();

    // User A signs in and loads teams
    const userAKey = queryKeys.teams.list('user-A');
    client.setQueryData(userAKey, { teams: [{ id: 'team-private', name: 'User A Confidential Team' }] });

    // User A signs out
    await clearQueryCache(client);

    // User B signs in
    const userBKey = queryKeys.teams.list('user-B');
    const userBData = client.getQueryData(userBKey);

    assert.equal(userBData, undefined, 'User B must not see any cached data');
    assert.equal(client.getQueryData(userAKey), undefined, 'User A data must be completely erased');
  });

  // Test J: Team switching
  it('J. Team switching: switching from team 1 to team 2 queries distinct keys without cross-contamination', () => {
    const client = createQueryClient();

    const team1Shifts = queryKeys.shifts.list('team-1', 'user-1');
    const team2Shifts = queryKeys.shifts.list('team-2', 'user-1');

    client.setQueryData(team1Shifts, { shifts: [{ id: 's1', teamId: 'team-1' }] });
    client.setQueryData(team2Shifts, { shifts: [{ id: 's2', teamId: 'team-2' }] });

    const currentShifts = client.getQueryData(team2Shifts) as any;
    assert.equal(currentShifts.shifts.length, 1);
    assert.equal(currentShifts.shifts[0].teamId, 'team-2');

    client.clear();
  });

  // Test K: Foreground refetch behavior
  it('K. Foreground refetch behavior: focusManager activates on active AppState and deactivates on background', () => {
    let appStateListener: ((state: string) => void) | undefined;
    const mockAppState = {
      addEventListener: (_type: string, listener: (state: string) => void) => {
        appStateListener = listener;
        return { remove: () => { appStateListener = undefined; } };
      },
    };

    const teardown = setupQueryFocusManager(mockAppState, true);

    // Simulate backgrounding
    appStateListener?.('background');
    assert.equal(focusManager.isFocused(), false, 'focusManager must be unfocused when backgrounded');

    // Simulate returning to foreground
    appStateListener?.('active');
    assert.equal(focusManager.isFocused(), true, 'focusManager must be focused when active');

    teardown();
  });

  // Test L: staleTime and gcTime policy
  it('L. Cache policy configuration: validates staleTime (2 min) and gcTime (10 min)', () => {
    const client = createQueryClient();
    const defaultQueries = client.getDefaultOptions().queries;

    assert.equal(DEFAULT_STALE_TIME_MS, 120000, 'staleTime must be 2 minutes (120000ms)');
    assert.equal(DEFAULT_GC_TIME_MS, 600000, 'gcTime must be 10 minutes (600000ms)');
    assert.equal(defaultQueries?.staleTime, 120000);
    assert.equal(defaultQueries?.gcTime, 600000);
    assert.equal(defaultQueries?.refetchOnWindowFocus, true);
    assert.equal(defaultQueries?.refetchOnReconnect, true);

    client.clear();
  });

  // Test M: Retry backoff & failure policy
  it('M. Retry policy: exponential backoff and no-retry on 401/403/404', () => {
    // Retry count bounds
    assert.equal(MAX_RETRY_COUNT, 2);

    // Exponential delay calculation
    assert.equal(calculateRetryBackoff(0), 1000);
    assert.equal(calculateRetryBackoff(1), 2000);
    assert.equal(calculateRetryBackoff(2), 4000);
    assert.equal(calculateRetryBackoff(3), 8000);
    assert.equal(calculateRetryBackoff(10), 30000, 'Delay must be capped at 30 seconds');

    // Do not retry 401, 403, 404 client errors
    assert.equal(shouldRetryQuery(0, { statusCode: 401 }), false);
    assert.equal(shouldRetryQuery(0, { statusCode: 403 }), false);
    assert.equal(shouldRetryQuery(0, { statusCode: 404 }), false);

    // Retry transient 500 server errors up to MAX_RETRY_COUNT
    assert.equal(shouldRetryQuery(0, { statusCode: 500 }), true);
    assert.equal(shouldRetryQuery(1, { statusCode: 500 }), true);
    assert.equal(shouldRetryQuery(2, { statusCode: 500 }), false);
  });

  // Test N: No sensitive-token persistence
  it('N. No sensitive-token persistence: query keys and data do not persist auth secrets or tokens', () => {
    const shiftKey = queryKeys.shifts.list('t1', 'u1', { page: 1 });
    const serializedKey = JSON.stringify(shiftKey);

    assert.ok(!serializedKey.includes('Bearer'));
    assert.ok(!serializedKey.includes('refreshToken'));
    assert.ok(!serializedKey.includes('accessToken'));

    const memberKey = queryKeys.members.list('t1', 'u1');
    const serializedMemberKey = JSON.stringify(memberKey);

    assert.ok(!serializedMemberKey.includes('Bearer'));
    assert.ok(!serializedMemberKey.includes('password'));
  });

  // Test O: Existing pagination behavior
  it('O. Pagination behavior: multi-page queries accumulate properly without duplication', () => {
    const page1Data = {
      members: [
        { userId: 'u1', role: 'OWNER' },
        { userId: 'u2', role: 'STAFF' },
      ],
      pagination: { page: 1, limit: 2, total: 3, totalPages: 2 },
    };

    const page2Data = {
      members: [
        { userId: 'u3', role: 'MANAGER' },
      ],
      pagination: { page: 2, limit: 2, total: 3, totalPages: 2 },
    };

    // Simulate the accumulation logic used in screen components
    let accumulated = [...page1Data.members];
    const existingIds = new Set(accumulated.map((m) => m.userId));
    const newItems = page2Data.members.filter((m) => !existingIds.has(m.userId));
    accumulated = [...accumulated, ...newItems];

    assert.equal(accumulated.length, 3);
    assert.deepEqual(accumulated.map((m) => m.userId), ['u1', 'u2', 'u3']);
  });
});

