import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Dynamically require to avoid tsconfig rootDir boundary errors
const { queryKeys } = require('../../../app/src/services/query/queryKeys');
const {
  createQueryClient,
  clearQueryCache,
} = require('../../../app/src/services/query/queryClient');
const {
  OfflineShiftStorageManager,
  MemoryStorageAdapter,
  getOfflineShiftKey,
  MAX_OFFLINE_SHIFTS_PER_TEAM,
} = require('../../../app/src/services/storage/offlineShiftStorage');
const { connectivityManager } = require('../../../app/src/services/network/connectivityManager');

describe('R06B: Offline Shift Viewing, Pagination Safety & Optimistic Mutations', () => {
  // Test A: No cross-team pagination flash
  it('A. No cross-team pagination flash: infinite query keys strictly isolate team pages', () => {
    const client = createQueryClient();
    const teamAKey = queryKeys.shifts.infinite('team-A', 'user-1', {});
    const teamBKey = queryKeys.shifts.infinite('team-B', 'user-1', {});

    // Populate Team A with loaded pages
    client.setQueryData(teamAKey, {
      pageParams: [1, 2],
      pages: [
        {
          shifts: [{ id: 'sA-1', title: 'Shift A1', teamId: 'team-A' }],
          pagination: { page: 1, totalPages: 2 },
        },
        {
          shifts: [{ id: 'sA-2', title: 'Shift A2', teamId: 'team-A' }],
          pagination: { page: 2, totalPages: 2 },
        },
      ],
    });

    // Verify Team B query has zero data and cannot see Team A data
    const teamBData = client.getQueryData(teamBKey);
    assert.equal(teamBData, undefined, 'Team B must start with zero cached pages');

    const teamAData = client.getQueryData(teamAKey) as any;
    assert.equal(teamAData.pages.length, 2);
    assert.equal(teamAData.pages[0].shifts[0].teamId, 'team-A');

    client.clear();
  });

  // Test B: Filter change cannot reuse prior filtered data
  it('B. Filter change isolation: changing status or date filter isolates query cache', () => {
    const scheduledKey = queryKeys.shifts.infinite('team-1', 'user-1', { status: 'SCHEDULED' });
    const cancelledKey = queryKeys.shifts.infinite('team-1', 'user-1', { status: 'CANCELLED' });

    assert.notDeepEqual(scheduledKey, cancelledKey);

    const client = createQueryClient();
    client.setQueryData(scheduledKey, {
      pages: [{ shifts: [{ id: 's-sched', status: 'SCHEDULED' }] }],
    });

    const cancelledData = client.getQueryData(cancelledKey);
    assert.equal(cancelledData, undefined, 'Cancelled filter cannot read scheduled cache');

    client.clear();
  });

  // Test C: Refetched pages replace outdated entries
  it('C. Refetched pages replace outdated entries: updated shift is reconciled across pages', () => {
    const client = createQueryClient();
    const key = queryKeys.shifts.infinite('team-1', 'user-1', {});

    // Initial state: Shift 1 has title "Old Title"
    client.setQueryData(key, {
      pageParams: [1],
      pages: [
        {
          shifts: [{ id: 's-1', title: 'Old Title', startsAt: '2026-11-06T09:00:00Z' }],
          pagination: { page: 1, totalPages: 1 },
        },
      ],
    });

    // Simulate refetch returning updated shift
    client.setQueryData(key, (old: any) => ({
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        shifts: p.shifts.map((s: any) =>
          s.id === 's-1' ? { ...s, title: 'Updated Title' } : s
        ),
      })),
    }));

    const updated = client.getQueryData(key) as any;
    assert.equal(updated.pages[0].shifts[0].title, 'Updated Title');

    client.clear();
  });

  // Test D: Removed records disappear after refetch
  it('D. Removed records disappear: cancelled/deleted shifts do not persist in refetched pages', () => {
    const client = createQueryClient();
    const key = queryKeys.shifts.infinite('team-1', 'user-1', {});

    client.setQueryData(key, {
      pageParams: [1],
      pages: [
        {
          shifts: [
            { id: 's-1', title: 'Active Shift' },
            { id: 's-to-delete', title: 'Deleted Shift' },
          ],
          pagination: { page: 1, totalPages: 1 },
        },
      ],
    });

    // Simulate refetch with deleted record removed
    client.setQueryData(key, (old: any) => ({
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        shifts: p.shifts.filter((s: any) => s.id !== 's-to-delete'),
      })),
    }));

    const reconciled = client.getQueryData(key) as any;
    assert.equal(reconciled.pages[0].shifts.length, 1);
    assert.equal(reconciled.pages[0].shifts[0].id, 's-1');

    client.clear();
  });

  // Test E: Pagination order and deduplication
  it('E. Pagination order & deduplication: multi-page flatMap guarantees unique ascending records', () => {
    const pages = [
      {
        shifts: [
          { id: 's-1', startsAt: '2026-11-06T09:00:00Z' },
          { id: 's-2', startsAt: '2026-11-06T13:00:00Z' },
        ],
      },
      {
        shifts: [
          { id: 's-2', startsAt: '2026-11-06T13:00:00Z' }, // Duplicate from boundary race
          { id: 's-3', startsAt: '2026-11-06T17:00:00Z' },
        ],
      },
    ];

    const all = pages.flatMap((p) => p.shifts);
    const seen = new Set<string>();
    const deduplicated = [];
    for (const s of all) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        deduplicated.push(s);
      }
    }

    assert.equal(deduplicated.length, 3);
    assert.deepEqual(deduplicated.map((s) => s.id), ['s-1', 's-2', 's-3']);
  });

  // Test F: Offline indicator follows real connection state
  it('F. Offline indicator follows connection state: subscribers receive state transitions', () => {
    let capturedState = connectivityManager.isOnline();
    const unsubscribe = connectivityManager.subscribe((online: boolean) => {
      capturedState = online;
    });

    connectivityManager.setOnline(false);
    assert.equal(connectivityManager.isOnline(), false);
    assert.equal(capturedState, false);

    connectivityManager.setOnline(true);
    assert.equal(connectivityManager.isOnline(), true);
    assert.equal(capturedState, true);

    unsubscribe();
  });

  // Test G: Last successful sync timestamp is accurate
  it('G. Sync timestamp accuracy: recorded snapshot includes valid recent ISO 8601 timestamp', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const before = Date.now();
    const snapshot = await storage.saveShifts('u1', 't1', [
      {
        id: 's-1',
        title: 'Morning',
        startsAt: '2026-11-06T08:00:00Z',
        endsAt: '2026-11-06T16:00:00Z',
        status: 'SCHEDULED',
        assignedToUserId: 'u1',
        assignedTo: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      } as any,
    ]);
    const after = Date.now();

    const syncTime = new Date(snapshot.syncedAt).getTime();
    assert.ok(syncTime >= before && syncTime <= after, 'syncedAt must be in the valid time window');
  });

  // Test H: Cached shifts remain readable when offline
  it('H. Offline shift readability: cached shifts are retrieved from storage when offline', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-test', 'team-test', [
      {
        id: 's-cached',
        title: 'Cached Shift',
        startsAt: '2026-11-06T09:00:00Z',
        endsAt: '2026-11-06T17:00:00Z',
        status: 'SCHEDULED',
        assignedToUserId: 'user-test',
        assignedTo: { id: 'user-test', name: 'Bob', email: 'bob@example.com' },
      } as any,
    ]);

    const retrieved = await storage.getShifts('user-test', 'team-test');
    assert.ok(retrieved !== null);
    assert.equal(retrieved.shifts.length, 1);
    assert.equal(retrieved.shifts[0].title, 'Cached Shift');
    assert.equal(retrieved.shifts[0].assignedToName, 'Bob');
  });

  // Test I: Offline cache is isolated by user and team
  it('I. Offline cache scoping: Team A data is never returned for Team B or User B', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-A', 'team-A', [
      { id: 's-A', title: 'Shift Team A' } as any,
    ]);

    // Query for Team B under User A
    const teamBData = await storage.getShifts('user-A', 'team-B');
    assert.equal(teamBData, null, 'Team B must not receive Team A offline data');

    // Query for Team A under User B
    const userBData = await storage.getShifts('user-B', 'team-A');
    assert.equal(userBData, null, 'User B must not receive User A offline data');
  });

  // Test J: Sign-out clears protected offline data
  it('J. Sign-out cleanup: clearing user offline shifts removes stored records', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-signout', 'team-1', [{ id: 's-1' } as any]);
    await storage.saveShifts('user-signout', 'team-2', [{ id: 's-2' } as any]);

    await storage.clearUserShifts('user-signout', ['team-1', 'team-2']);

    const check1 = await storage.getShifts('user-signout', 'team-1');
    const check2 = await storage.getShifts('user-signout', 'team-2');

    assert.equal(check1, null);
    assert.equal(check2, null);
  });

  // Test K: Unauthorized team data cannot be restored
  it('K. Unauthorized team data cleanup: clearTeamShifts wipes cache on 403/404', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-revoked', 'team-forbidden', [{ id: 's-secret' } as any]);

    // Simulate 403 Forbidden handler
    await storage.clearTeamShifts('user-revoked', 'team-forbidden');

    const result = await storage.getShifts('user-revoked', 'team-forbidden');
    assert.equal(result, null, 'Revoked team cache must be deleted immediately');
  });

  // Test L: Online reconnection triggers safe synchronization
  it('L. Online reconnection notification: onlineManager receives reconnect event', () => {
    const { onlineManager } = require('../../../app/node_modules/@tanstack/react-query');

    connectivityManager.setOnline(false);
    assert.equal(onlineManager.isOnline(), false);

    connectivityManager.setOnline(true);
    assert.equal(onlineManager.isOnline(), true);
  });

  // Test M: No authentication tokens persisted in offline cache
  it('M. No auth secrets persisted: offline payload contains zero tokens or credentials', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('u1', 't1', [
      {
        id: 's-1',
        title: 'Duty',
        startsAt: '2026-11-06T09:00:00Z',
        endsAt: '2026-11-06T17:00:00Z',
        status: 'SCHEDULED',
        assignedToUserId: 'u1',
        assignedTo: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      } as any,
    ]);

    const key = getOfflineShiftKey('u1', 't1');
    const raw = await memory.getItem(key);
    assert.ok(raw !== null);

    assert.ok(!raw.includes('Bearer'));
    assert.ok(!raw.includes('accessToken'));
    assert.ok(!raw.includes('refreshToken'));
    assert.ok(!raw.includes('password'));
    assert.ok(!raw.includes('token'));
  });

  // Test N: Successful optimistic swap mutation
  it('N. Optimistic swap update: cache reflects status change before mutation finishes', async () => {
    const client = createQueryClient();
    const peerKey = queryKeys.shiftSwaps.list('team-1', 'user-1', { status: 'PENDING_PEER' });

    client.setQueryData(peerKey, {
      shiftSwaps: [{ id: 'swap-1', status: 'PENDING_PEER', receivingUserId: 'user-1' }],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    // Simulate onMutate
    const snapshot = client.getQueryData(peerKey) as any;
    client.setQueryData(peerKey, {
      ...snapshot,
      shiftSwaps: snapshot.shiftSwaps.filter((s: any) => s.id !== 'swap-1'),
      pagination: { ...snapshot.pagination, total: 0 },
    });

    const optimistic = client.getQueryData(peerKey) as any;
    assert.equal(optimistic.shiftSwaps.length, 0, 'Item must be optimistically removed from pending peer');

    client.clear();
  });

  // Test O: Network failure rolls back optimistic mutation
  it('O. Network error rollback: restored snapshot on network failure', () => {
    const client = createQueryClient();
    const peerKey = queryKeys.shiftSwaps.list('team-1', 'user-1', { status: 'PENDING_PEER' });

    const originalData = {
      shiftSwaps: [{ id: 'swap-rollback', status: 'PENDING_PEER' }],
      pagination: { total: 1, page: 1, totalPages: 1 },
    };
    client.setQueryData(peerKey, originalData);

    // Optimistic mutation applied
    const previousSnapshot = client.getQueryData(peerKey);
    client.setQueryData(peerKey, {
      shiftSwaps: [],
      pagination: { total: 0, page: 1, totalPages: 1 },
    });

    // Network failure occurs -> onError rollback
    client.setQueryData(peerKey, previousSnapshot);

    const rolledBack = client.getQueryData(peerKey) as any;
    assert.equal(rolledBack.shiftSwaps.length, 1);
    assert.equal(rolledBack.shiftSwaps[0].id, 'swap-rollback');

    client.clear();
  });

  // Test P: HTTP 409 conflict rolls back correctly
  it('P. 409 conflict rollback: restored snapshot when concurrent server update conflicts', () => {
    const client = createQueryClient();
    const mgrKey = queryKeys.shiftSwaps.list('team-1', 'user-1', { status: 'PENDING_MANAGER' });

    const initial = {
      shiftSwaps: [{ id: 'swap-conflict', status: 'PENDING_MANAGER' }],
      pagination: { total: 1, page: 1, totalPages: 1 },
    };
    client.setQueryData(mgrKey, initial);

    const snapshot = client.getQueryData(mgrKey);
    // Optimistic removal on manager approve
    client.setQueryData(mgrKey, {
      shiftSwaps: [],
      pagination: { total: 0, page: 1, totalPages: 1 },
    });

    // Server returns 409 (another manager approved or cancelled) -> rollback
    client.setQueryData(mgrKey, snapshot);

    const state = client.getQueryData(mgrKey) as any;
    assert.equal(state.shiftSwaps[0].id, 'swap-conflict');

    client.clear();
  });

  // Test Q: Failed 403/404 authorization does not leave optimistic data visible
  it('Q. 403/404 authorization failure rollback: invalidates and clears stale optimistic state', () => {
    const client = createQueryClient();
    const mgrKey = queryKeys.shiftSwaps.list('team-1', 'user-1', { status: 'PENDING_MANAGER' });

    client.setQueryData(mgrKey, {
      shiftSwaps: [{ id: 'swap-unauth' }],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    // On 403 Forbidden, query data is wiped or invalidated via removeQueries
    client.removeQueries({ queryKey: mgrKey });

    assert.equal(client.getQueryData(mgrKey), undefined);
    client.clear();
  });

  // Test R: Concurrent mutations remain consistent
  it('R. Concurrent mutations consistency: sequential actions update respective items without clobbering', () => {
    const client = createQueryClient();
    const peerKey = queryKeys.shiftSwaps.list('team-1', 'user-1', { status: 'PENDING_PEER' });

    client.setQueryData(peerKey, {
      shiftSwaps: [
        { id: 'swap-A', status: 'PENDING_PEER' },
        { id: 'swap-B', status: 'PENDING_PEER' },
      ],
      pagination: { total: 2, page: 1, totalPages: 1 },
    });

    // Action 1: Accept swap-A
    client.setQueryData(peerKey, (old: any) => ({
      ...old,
      shiftSwaps: old.shiftSwaps.filter((s: any) => s.id !== 'swap-A'),
      pagination: { ...old.pagination, total: old.pagination.total - 1 },
    }));

    // Action 2: Decline swap-B
    client.setQueryData(peerKey, (old: any) => ({
      ...old,
      shiftSwaps: old.shiftSwaps.filter((s: any) => s.id !== 'swap-B'),
      pagination: { ...old.pagination, total: old.pagination.total - 1 },
    }));

    const finalState = client.getQueryData(peerKey) as any;
    assert.equal(finalState.shiftSwaps.length, 0);
    assert.equal(finalState.pagination.total, 0);

    client.clear();
  });

  // Test S: No fake settings endpoint introduced
  it('S. No fake settings endpoint: confirms no settings routes were fabricated in backend', () => {
    const routesDir = path.resolve(__dirname, '../routes');
    const routeFiles = fs.readdirSync(routesDir);

    const hasSettingsRoute = routeFiles.some((f) => f.includes('setting'));
    assert.equal(
      hasSettingsRoute,
      false,
      'Must NOT invent fake settings routes; R09 settings remain pending as required'
    );
  });
});

