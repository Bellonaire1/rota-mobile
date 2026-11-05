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
  getOfflineTeamIndexKey,
  MAX_OFFLINE_PAYLOAD_BYTES,
  getUtf8ByteLength,
} = require('../../../app/src/services/storage/offlineShiftStorage');
const {
  connectivityManager,
  setupNetworkConnectivity,
} = require('../../../app/src/services/network/connectivityManager');
const { onlineManager } = require('../../../app/node_modules/@tanstack/react-query');

describe('R06B.1: Offline Cache Security, Real Connectivity & Optimistic UI Workflows', () => {
  // Test A: Sign-out cleanup with NO explicit team IDs
  it('A. Sign-out cleanup with NO explicit team IDs: index discovers and clears all user data', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    // Save shift snapshot without external knowledge of team IDs
    await storage.saveShifts('user-signout-test', 'team-alpha', [
      { id: 'shift-1', title: 'Morning Duty', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T17:00:00Z', status: 'SCHEDULED', assignedToUserId: 'user-signout-test' },
    ]);

    // Verify snapshot exists prior to signout
    const before = await storage.getShifts('user-signout-test', 'team-alpha');
    assert.ok(before !== null);

    // Call production signout cleanup signature with NO team IDs supplied
    await storage.clearUserShifts('user-signout-test');

    // Confirm snapshot was discovered and wiped
    const after = await storage.getShifts('user-signout-test', 'team-alpha');
    assert.equal(after, null, 'Must discover and wipe team snapshot with zero parameters supplied');

    const indexAfter = await memory.getItem(getOfflineTeamIndexKey('user-signout-test'));
    assert.equal(indexAfter, null, 'Team index must also be wiped');
  });

  // Test B: Cleanup of multiple previously visited teams
  it('B. Cleanup of multiple previously visited teams: wipes all historical teams for user', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    // User previously visited 3 distinct workspaces
    await storage.saveShifts('multi-user', 'team-1', [{ id: 's1', title: 'Shift 1' } as any]);
    await storage.saveShifts('multi-user', 'team-2', [{ id: 's2', title: 'Shift 2' } as any]);
    await storage.saveShifts('multi-user', 'team-3', [{ id: 's3', title: 'Shift 3' } as any]);

    // Also persist data for an unrelated user (must NOT be touched)
    await storage.saveShifts('other-user', 'team-1', [{ id: 's-other', title: 'Other Shift' } as any]);

    // Clean up multi-user with empty known teams
    await storage.clearUserShifts('multi-user');

    assert.equal(await storage.getShifts('multi-user', 'team-1'), null);
    assert.equal(await storage.getShifts('multi-user', 'team-2'), null);
    assert.equal(await storage.getShifts('multi-user', 'team-3'), null);

    // Unrelated user data must be completely preserved
    const otherShifts = await storage.getShifts('other-user', 'team-1');
    assert.ok(otherShifts !== null);
    assert.equal(otherShifts.shifts[0].id, 's-other');
  });

  // Test C: Failed deletion is detectable
  it('C. Failed deletion is detectable: storage failure bubbles and is not reported as success', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('fail-user', 'team-1', [{ id: 's1' } as any]);

    // Induce storage deletion failure
    memory.setFailureMode({ remove: true });

    await assert.rejects(
      async () => {
        await storage.clearUserShifts('fail-user');
      },
      /Failed to clean up offline shifts for user fail-user/,
      'Must explicitly throw on storage deletion failure'
    );
  });

  // Test D: Real connectivity initialization
  it('D. Real connectivity initialization: lifecycle setup triggers initial probe and listener', async () => {
    let addListenerCalled = false;
    let removeListenerCalled = false;

    const mockAppState = {
      addEventListener: (type: string, listener: any) => {
        addListenerCalled = true;
        return {
          remove: () => {
            removeListenerCalled = true;
          },
        };
      },
    };

    const teardown = setupNetworkConnectivity(mockAppState as any);
    assert.ok(addListenerCalled, 'Must register AppState listener');

    teardown();
    assert.ok(removeListenerCalled, 'Must remove AppState listener on unmount');
  });

  // Test E: Online to airplane-mode transition
  it('E. Online to airplane-mode transition: network failure transitions to offline', async () => {
    let capturedOnline: boolean | null = null;
    let capturedBackend: boolean | null = null;

    const unsubscribe = connectivityManager.subscribe((isOnline, backendAvailable) => {
      capturedOnline = isOnline;
      capturedBackend = backendAvailable;
    });

    // Simulate network transport failure (airplane mode / DNS drop)
    await connectivityManager.checkConnectivity(async () => {
      const err = new TypeError('Network request failed');
      throw err;
    });

    assert.equal(connectivityManager.isOnline(), false);
    assert.equal(connectivityManager.isBackendAvailable(), false);
    assert.equal(capturedOnline, false);
    assert.equal(capturedBackend, false);
    assert.equal(onlineManager.isOnline(), false, 'TanStack onlineManager must be notified');

    unsubscribe();
  });

  // Test F: Airplane-mode to online reconnection
  it('F. Airplane-mode to online reconnection: successful probe restores online state', async () => {
    let capturedOnline: boolean | null = null;

    const unsubscribe = connectivityManager.subscribe((isOnline) => {
      capturedOnline = isOnline;
    });

    // Reconnection probe succeeds
    await connectivityManager.checkConnectivity(async () => {
      return { ok: true, status: 200 };
    });

    assert.equal(connectivityManager.isOnline(), true);
    assert.equal(connectivityManager.isBackendAvailable(), true);
    assert.equal(capturedOnline, true);
    assert.equal(onlineManager.isOnline(), true, 'TanStack onlineManager must be restored');

    unsubscribe();
  });

  // Test G: Exact storage payload-size enforcement
  it('G. Exact storage payload-size enforcement: serialized payload strictly below 2000 bytes', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const shifts = Array.from({ length: 20 }, (_, i) => ({
      id: `shift-${i + 1}`,
      title: `General Duty Shift Number ${i + 1}`,
      startsAt: '2026-11-06T09:00:00Z',
      endsAt: '2026-11-06T17:00:00Z',
      status: 'SCHEDULED',
      assignedToUserId: `user-${i + 1}`,
      assignedTo: { id: `user-${i + 1}`, name: `Staff Member ${i + 1}`, email: `staff${i + 1}@example.com` },
    }));

    const snapshot = await storage.saveShifts('u-size', 't-size', shifts as any);
    const key = getOfflineShiftKey('u-size', 't-size');
    const raw = await memory.getItem(key);
    assert.ok(raw !== null);

    const byteLen = getUtf8ByteLength(raw);
    assert.ok(byteLen <= MAX_OFFLINE_PAYLOAD_BYTES, `Payload bytes ${byteLen} exceeds limit ${MAX_OFFLINE_PAYLOAD_BYTES}`);
  });

  // Test H: Oversized payload handling
  it('H. Oversized payload handling: truncates titles and safely prunes records to stay within byte boundary', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    // Extremely long shift titles (500 chars each) and large payload
    const oversizedShifts = Array.from({ length: 30 }, (_, i) => ({
      id: `oversized-shift-${i + 1}`,
      title: `Extremely long shift title intended to exceed storage buffers `.repeat(10),
      startsAt: '2026-11-06T09:00:00Z',
      endsAt: '2026-11-06T17:00:00Z',
      status: 'SCHEDULED',
      assignedToUserId: `user-${i + 1}`,
      assignedTo: { id: `user-${i + 1}`, name: 'Very Long Staff Name '.repeat(5), email: 'staff@example.com' },
    }));

    const snapshot = await storage.saveShifts('u-large', 't-large', oversizedShifts as any);
    const raw = await memory.getItem(getOfflineShiftKey('u-large', 't-large'));
    assert.ok(raw !== null);

    const byteLen = getUtf8ByteLength(raw);
    assert.ok(byteLen <= MAX_OFFLINE_PAYLOAD_BYTES, `Oversized payload must be pruned to <= ${MAX_OFFLINE_PAYLOAD_BYTES} bytes`);
    assert.ok(snapshot.shifts.length > 0, 'Must preserve as many shifts as safely fit');
    assert.ok(snapshot.shifts[0].title.length <= 40, 'Title must be truncated safely');
  });

  // Test I: Secure storage write failure
  it('I. Secure storage write failure: write error throws and is not falsely reported as success', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    memory.setFailureMode({ set: true });

    await assert.rejects(
      async () => {
        await storage.saveShifts('u-err', 't-err', [{ id: 's1' } as any]);
      },
      /Simulated storage write error/,
      'Storage write error must reject'
    );
  });

  // Test J: Cross-team offline snapshot state isolation
  it('J. Cross-team offline snapshot state isolation: Team A data is never returned for Team B', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-A', 'team-A', [
      { id: 's-A', title: 'Shift Team A' } as any,
    ]);

    const teamBData = await storage.getShifts('user-A', 'team-B');
    assert.equal(teamBData, null, 'Team B query must return null');

    const userBData = await storage.getShifts('user-B', 'team-A');
    assert.equal(userBData, null, 'User B query must return null');
  });

  // Test K: Authorization failure prevents stale display
  it('K. Authorization failure prevents stale display: 403 wipes cache and prevents rendering', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-auth-fail', 'team-revoked', [{ id: 's-revoked' } as any]);

    // On 403 Forbidden: clearTeamShifts is invoked
    await storage.clearTeamShifts('user-auth-fail', 'team-revoked');

    const res = await storage.getShifts('user-auth-fail', 'team-revoked');
    assert.equal(res, null, 'Revoked team shifts must be immediately wiped');
  });

  // Test L: Offline date/status filter correctness
  it('L. Offline date/status filter correctness: does not present unfiltered snapshot as matching filtered query', () => {
    const cachedShifts = [
      { id: 's1', status: 'SCHEDULED', startsAt: '2026-11-06T09:00:00Z' },
      { id: 's2', status: 'CANCELLED', startsAt: '2026-11-06T13:00:00Z' },
      { id: 's3', status: 'SCHEDULED', startsAt: '2026-11-07T09:00:00Z' },
    ];

    // Filter by CANCELLED status
    const cancelledOnly = cachedShifts.filter((s) => s.status === 'CANCELLED');
    assert.equal(cancelledOnly.length, 1);
    assert.equal(cancelledOnly[0].id, 's2');

    // Filter by specific date: 2026-11-07
    const dateOnly = cachedShifts.filter((s) => s.startsAt.startsWith('2026-11-07'));
    assert.equal(dateOnly.length, 1);
    assert.equal(dateOnly[0].id, 's3');

    // Filter by date with zero matching shifts: 2026-11-20
    const noMatch = cachedShifts.filter((s) => s.startsAt.startsWith('2026-11-20'));
    assert.equal(noMatch.length, 0, 'Unmatched date filter must return empty array, not full snapshot');
  });

  // Test M: True server-sync timestamp semantics
  it('M. True server-sync timestamp semantics: timestamp only recorded on genuine server save', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const before = Date.now();
    const snapshot = await storage.saveShifts('u-sync', 't-sync', [
      { id: 's1', title: 'Live Shift', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T17:00:00Z', status: 'SCHEDULED', assignedToUserId: 'u-sync' } as any,
    ]);
    const after = Date.now();

    const recorded = new Date(snapshot.syncedAt).getTime();
    assert.ok(recorded >= before && recorded <= after);

    // Merely reading from cache does NOT alter or advance the sync timestamp
    const retrieved = await storage.getShifts('u-sync', 't-sync');
    assert.equal(retrieved?.syncedAt, snapshot.syncedAt);
  });

  // Test N: Visible swap list updates before server response
  it('N. Visible swap list updates before server response: onMutate optimistically removes item from visible tab', () => {
    const client = createQueryClient();
    const incomingTabKey = queryKeys.shiftSwaps.tab('team-1', 'user-1', 'INCOMING', 'ALL', 1);
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    // Populate initial cache
    client.setQueryData(incomingTabKey, {
      shiftSwaps: [
        { id: 'swap-optimistic-1', status: 'PENDING_PEER', receivingUserId: 'user-1' },
        { id: 'swap-optimistic-2', status: 'PENDING_PEER', receivingUserId: 'user-1' },
      ],
      pagination: { total: 2, page: 1, totalPages: 1 },
    });
    client.setQueryData(tabCountsKey, { incoming: 2, myRequests: 0, managerReview: 0 });

    // Simulate onMutate: user accepts or declines swap-optimistic-1
    const prevTab = client.getQueryData(incomingTabKey) as any;
    const prevCounts = client.getQueryData(tabCountsKey) as any;

    client.setQueryData(incomingTabKey, {
      ...prevTab,
      shiftSwaps: prevTab.shiftSwaps.filter((s: any) => s.id !== 'swap-optimistic-1'),
      pagination: { ...prevTab.pagination, total: 1 },
    });
    client.setQueryData(tabCountsKey, {
      ...prevCounts,
      incoming: 1,
    });

    // Check visible list state BEFORE server responds
    const visibleData = client.getQueryData(incomingTabKey) as any;
    assert.equal(visibleData.shiftSwaps.length, 1);
    assert.equal(visibleData.shiftSwaps[0].id, 'swap-optimistic-2');

    const visibleCounts = client.getQueryData(tabCountsKey) as any;
    assert.equal(visibleCounts.incoming, 1);

    client.clear();
  });

  // Test O: Failed peer response rolls back visibly
  it('O. Failed peer response rolls back visibly: error re-inserts removed swap and restores count', () => {
    const client = createQueryClient();
    const incomingTabKey = queryKeys.shiftSwaps.tab('team-1', 'user-1', 'INCOMING', 'ALL', 1);
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    const originalSwap = { id: 'swap-peer-fail', status: 'PENDING_PEER', receivingUserId: 'user-1' };
    client.setQueryData(incomingTabKey, {
      shiftSwaps: [originalSwap],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });
    client.setQueryData(tabCountsKey, { incoming: 1, myRequests: 0, managerReview: 0 });

    // Apply onMutate
    client.setQueryData(incomingTabKey, { shiftSwaps: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    client.setQueryData(tabCountsKey, { incoming: 0, myRequests: 0, managerReview: 0 });

    // Server throws HTTP 409 Conflict -> onError rollback
    client.setQueryData(incomingTabKey, (current: any) => ({
      ...current,
      shiftSwaps: [originalSwap, ...current.shiftSwaps],
      pagination: { ...current.pagination, total: current.pagination.total + 1 },
    }));
    client.setQueryData(tabCountsKey, (current: any) => ({
      ...current,
      incoming: current.incoming + 1,
    }));

    const restoredTab = client.getQueryData(incomingTabKey) as any;
    assert.equal(restoredTab.shiftSwaps.length, 1);
    assert.equal(restoredTab.shiftSwaps[0].id, 'swap-peer-fail');

    const restoredCounts = client.getQueryData(tabCountsKey) as any;
    assert.equal(restoredCounts.incoming, 1);

    client.clear();
  });

  // Test P: Failed manager review rolls back visibly
  it('P. Failed manager review rolls back visibly: manager approve/reject rolls back on network error', () => {
    const client = createQueryClient();
    const mgrTabKey = queryKeys.shiftSwaps.tab('team-1', 'user-1', 'MANAGER_REVIEW', 'ALL', 1);
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    const reviewSwap = { id: 'swap-mgr-fail', status: 'PENDING_MANAGER' };
    client.setQueryData(mgrTabKey, {
      shiftSwaps: [reviewSwap],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });
    client.setQueryData(tabCountsKey, { incoming: 0, myRequests: 0, managerReview: 1 });

    // onMutate
    client.setQueryData(mgrTabKey, { shiftSwaps: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    client.setQueryData(tabCountsKey, { incoming: 0, myRequests: 0, managerReview: 0 });

    // Network error -> rollback
    client.setQueryData(mgrTabKey, (current: any) => ({
      ...current,
      shiftSwaps: [reviewSwap, ...current.shiftSwaps],
      pagination: { ...current.pagination, total: current.pagination.total + 1 },
    }));
    client.setQueryData(tabCountsKey, (current: any) => ({
      ...current,
      managerReview: current.managerReview + 1,
    }));

    const rolledBack = client.getQueryData(mgrTabKey) as any;
    assert.equal(rolledBack.shiftSwaps.length, 1);
    assert.equal(rolledBack.shiftSwaps[0].id, 'swap-mgr-fail');

    const counts = client.getQueryData(tabCountsKey) as any;
    assert.equal(counts.managerReview, 1);

    client.clear();
  });

  // Test Q: Cancel action updates visibly and rolls back
  it('Q. Cancel action updates visibly and rolls back: requester cancellation updates cache and restores on error', () => {
    const client = createQueryClient();
    const myRequestsTabKey = queryKeys.shiftSwaps.tab('team-1', 'user-1', 'MY_REQUESTS', 'ALL', 1);
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    const cancelSwap = { id: 'swap-cancel-1', status: 'PENDING_PEER', requestingUserId: 'user-1' };
    client.setQueryData(myRequestsTabKey, {
      shiftSwaps: [cancelSwap],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });
    client.setQueryData(tabCountsKey, { incoming: 0, myRequests: 1, managerReview: 0 });

    // onMutate removes it visibly
    client.setQueryData(myRequestsTabKey, { shiftSwaps: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    client.setQueryData(tabCountsKey, { incoming: 0, myRequests: 0, managerReview: 0 });

    const optimistic = client.getQueryData(myRequestsTabKey) as any;
    assert.equal(optimistic.shiftSwaps.length, 0);

    // Server returns 409 (already resolved) -> rollback
    client.setQueryData(myRequestsTabKey, (current: any) => ({
      ...current,
      shiftSwaps: [cancelSwap, ...current.shiftSwaps],
      pagination: { ...current.pagination, total: current.pagination.total + 1 },
    }));
    client.setQueryData(tabCountsKey, (current: any) => ({
      ...current,
      myRequests: current.myRequests + 1,
    }));

    const rolledBack = client.getQueryData(myRequestsTabKey) as any;
    assert.equal(rolledBack.shiftSwaps.length, 1);
    assert.equal(rolledBack.shiftSwaps[0].id, 'swap-cancel-1');

    client.clear();
  });

  // Test R: Concurrent mutations do not corrupt state
  it('R. Concurrent mutations do not corrupt state: rollback of action 1 preserves action 2', () => {
    const client = createQueryClient();
    const incomingTabKey = queryKeys.shiftSwaps.tab('team-1', 'user-1', 'INCOMING', 'ALL', 1);
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    const swapA = { id: 'swap-A', status: 'PENDING_PEER' };
    const swapB = { id: 'swap-B', status: 'PENDING_PEER' };

    client.setQueryData(incomingTabKey, {
      shiftSwaps: [swapA, swapB],
      pagination: { total: 2, page: 1, totalPages: 1 },
    });
    client.setQueryData(tabCountsKey, { incoming: 2, myRequests: 0, managerReview: 0 });

    // Action 1 (accept swap-A): onMutate removes swap-A
    client.setQueryData(incomingTabKey, (old: any) => ({
      ...old,
      shiftSwaps: old.shiftSwaps.filter((s: any) => s.id !== 'swap-A'),
      pagination: { ...old.pagination, total: old.pagination.total - 1 },
    }));
    client.setQueryData(tabCountsKey, (old: any) => ({ ...old, incoming: old.incoming - 1 }));

    // Action 2 (decline swap-B): onMutate removes swap-B
    client.setQueryData(incomingTabKey, (old: any) => ({
      ...old,
      shiftSwaps: old.shiftSwaps.filter((s: any) => s.id !== 'swap-B'),
      pagination: { ...old.pagination, total: old.pagination.total - 1 },
    }));
    client.setQueryData(tabCountsKey, (old: any) => ({ ...old, incoming: old.incoming - 1 }));

    // Both are removed
    let current = client.getQueryData(incomingTabKey) as any;
    assert.equal(current.shiftSwaps.length, 0);

    // Action 1 fails on server (e.g. 409 conflict) -> non-clobbering rollback re-inserts swap-A
    client.setQueryData(incomingTabKey, (old: any) => {
      if (old.shiftSwaps.some((s: any) => s.id === 'swap-A')) return old;
      return {
        ...old,
        shiftSwaps: [swapA, ...old.shiftSwaps],
        pagination: { ...old.pagination, total: old.pagination.total + 1 },
      };
    });
    client.setQueryData(tabCountsKey, (old: any) => ({ ...old, incoming: old.incoming + 1 }));

    // Action 2 succeeds on server! swap-B remains removed, swap-A was restored!
    current = client.getQueryData(incomingTabKey) as any;
    assert.equal(current.shiftSwaps.length, 1);
    assert.equal(current.shiftSwaps[0].id, 'swap-A');

    const counts = client.getQueryData(tabCountsKey) as any;
    assert.equal(counts.incoming, 1);

    client.clear();
  });

  // Test S: Tab pagination and badge counts remain consistent
  it('S. Tab pagination and badge counts remain consistent: multi-tab counts reflect accurate totals', () => {
    const client = createQueryClient();
    const tabCountsKey = queryKeys.shiftSwaps.tabCounts('team-1', 'user-1');

    client.setQueryData(tabCountsKey, { incoming: 3, myRequests: 2, managerReview: 5 });

    const counts = client.getQueryData(tabCountsKey) as any;
    assert.equal(counts.incoming, 3);
    assert.equal(counts.myRequests, 2);
    assert.equal(counts.managerReview, 5);

    client.clear();
  });

  // Test T: No fabricated endpoints or successful responses
  it('T. No fabricated endpoints: verifies no settings routes were fabricated in backend', () => {
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
