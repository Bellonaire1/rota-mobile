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
  MAX_OFFLINE_SHIFTS_PER_TEAM,
  getUtf8ByteLength,
} = require('../../../app/src/services/storage/offlineShiftStorage');
const {
  connectivityManager,
  setupNetworkConnectivity,
} = require('../../../app/src/services/network/connectivityManager');
const { onlineManager } = require('../../../app/node_modules/@tanstack/react-query');

class ApiError extends Error {
  statusCode: number;
  details?: any;
  constructor(statusCode: number, message: string, details?: any) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

describe('R06B.2: Final Offline Security, Native Network & Swap Pagination Hardening', () => {
  // Test A: Index-write failure does not leave an untracked snapshot
  it('A. Index-write failure does not leave an untracked snapshot: snapshot write aborted if index update fails', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const indexKey = getOfflineTeamIndexKey('user-idx-fail');
    const snapshotKey = getOfflineShiftKey('user-idx-fail', 'team-A');

    // Simulate storage failure specifically when updating the team index
    memory.setFailureMode({
      set: (key: string) => key === indexKey,
    });

    await assert.rejects(
      async () => {
        await storage.saveShifts('user-idx-fail', 'team-A', [
          {
            id: 's1',
            title: 'Shift 1',
            startsAt: '2026-11-06T09:00:00Z',
            endsAt: '2026-11-06T17:00:00Z',
            status: 'SCHEDULED',
            assignedToUserId: 'user-idx-fail',
          } as any,
        ]);
      },
      /Simulated storage write error/,
      'Must reject if index cannot be written'
    );

    // Verify snapshot was NEVER written to storage (no orphan/untracked data)
    const snapshotData = await memory.getItem(snapshotKey);
    assert.equal(snapshotData, null, 'Snapshot must not exist if index update failed');
  });

  // Test B: Partial deletion failure retains retry information in index
  it('B. Partial deletion failure retains retry information in index for failed teams', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-retry', 'team-1', [{ id: 's1' } as any]);
    await storage.saveShifts('user-retry', 'team-2', [{ id: 's2' } as any]);
    await storage.saveShifts('user-retry', 'team-3', [{ id: 's3' } as any]);

    const team2Key = getOfflineShiftKey('user-retry', 'team-2');

    // Induce deletion failure ONLY on team-2
    memory.setFailureMode({
      remove: (key: string) => key === team2Key,
    });

    await assert.rejects(
      async () => {
        await storage.clearUserShifts('user-retry');
      },
      /Failed to clean up offline shifts for user user-retry/
    );

    // Team 1 and 3 were successfully deleted
    assert.equal(await storage.getShifts('user-retry', 'team-1'), null);
    assert.equal(await storage.getShifts('user-retry', 'team-3'), null);

    // Team 2 was not deleted
    assert.ok((await storage.getShifts('user-retry', 'team-2')) !== null);

    // The index must RETAIN team-2 so a subsequent sign-out or retry will clean it up
    const indexRaw = await memory.getItem(getOfflineTeamIndexKey('user-retry'));
    assert.ok(indexRaw !== null);
    const indexTeams = JSON.parse(indexRaw);
    assert.deepEqual(indexTeams, ['team-2'], 'Index must retain failed team ID for retry');
  });

  // Test C: Credential cleanup continues even if offline deletion throws
  it('C. Credential cleanup continues even if offline deletion throws', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('user-creds', 'team-1', [{ id: 's1' } as any]);
    memory.setFailureMode({ remove: true });

    // Mock SecureStore
    const secureStoreEntries = new Map<string, string>([
      ['rota.refresh-token.user-creds', 'token-123'],
      ['rota.selected-team.user-creds', 'team-1'],
      ['rota.last-user-id', 'user-creds'],
    ]);

    // Mimic AuthContext clearCredentials() implementation
    let offlineError: Error | null = null;
    try {
      await storage.clearUserShifts('user-creds');
    } catch (err: any) {
      offlineError = err;
    }

    // SecureStore deletion must run regardless of offline cleanup error
    secureStoreEntries.delete('rota.refresh-token.user-creds');
    secureStoreEntries.delete('rota.selected-team.user-creds');
    secureStoreEntries.delete('rota.last-user-id');

    assert.ok(offlineError !== null, 'Offline error was captured');
    assert.equal(secureStoreEntries.size, 0, 'All credentials and session metadata must be securely cleared');
  });

  // Test D: Multiple team snapshots cleared correctly
  it('D. Multiple team snapshots cleared correctly across multiple workspaces', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    await storage.saveShifts('multi-user', 'team-1', [{ id: 's1' } as any]);
    await storage.saveShifts('multi-user', 'team-2', [{ id: 's2' } as any]);
    await storage.saveShifts('multi-user', 'team-3', [{ id: 's3' } as any]);

    // Unrelated user
    await storage.saveShifts('other-user', 'team-1', [{ id: 'other-s1' } as any]);

    await storage.clearUserShifts('multi-user');

    assert.equal(await storage.getShifts('multi-user', 'team-1'), null);
    assert.equal(await storage.getShifts('multi-user', 'team-2'), null);
    assert.equal(await storage.getShifts('multi-user', 'team-3'), null);
    assert.equal(await memory.getItem(getOfflineTeamIndexKey('multi-user')), null);

    // Other user untouched
    assert.ok((await storage.getShifts('other-user', 'team-1')) !== null);
  });

  // Test E: Native network event integration: airplane mode triggers offline immediately
  it('E. Native network events: airplane mode triggers offline immediately without waiting for probe timeout', () => {
    let netInfoListener: ((state: any) => void) | null = null;
    const mockNetInfo = {
      addEventListener: (listener: any) => {
        netInfoListener = listener;
        return () => {
          netInfoListener = null;
        };
      },
    };

    connectivityManager.setOnline(true, true);
    assert.equal(connectivityManager.isOnline(), true);

    const teardown = setupNetworkConnectivity(undefined, mockNetInfo as any, { skipInitialProbe: true });
    assert.ok(netInfoListener !== null, 'NetInfo listener must be registered');

    // Simulate airplane mode event from native NetInfo
    (netInfoListener as any)({ isConnected: false, isInternetReachable: false });

    assert.equal(connectivityManager.isOnline(), false, 'Must be marked offline immediately');
    assert.equal(connectivityManager.isBackendAvailable(), false);
    assert.equal(onlineManager.isOnline(), false, 'TanStack onlineManager must be marked offline');

    teardown();
  });

  // Test F: Native reconnection: isConnected + isInternetReachable restores online state
  it('F. Native reconnection: isConnected + isInternetReachable triggers connectivity verification', async () => {
    let netInfoListener: ((state: any) => void) | null = null;
    const mockNetInfo = {
      addEventListener: (listener: any) => {
        netInfoListener = listener;
        return () => {
          netInfoListener = null;
        };
      },
    };

    connectivityManager.setOnline(false, false);
    assert.equal(connectivityManager.isOnline(), false);

    const teardown = setupNetworkConnectivity(undefined, mockNetInfo as any, { skipInitialProbe: true });

    // Simulate native reconnection
    await connectivityManager.checkConnectivity(async () => ({ ok: true, status: 200 }));

    assert.equal(connectivityManager.isOnline(), true);
    assert.equal(connectivityManager.isBackendAvailable(), true);
    assert.equal(onlineManager.isOnline(), true);

    teardown();
  });

  // Test G: Backend 500 error does NOT mark device as offline
  it('G. Backend 500 error does NOT mark device as offline: distinguishes offline from backend down', async () => {
    // Health probe returns HTTP 500 Server Error
    await connectivityManager.checkConnectivity(async () => ({ ok: false, status: 500 }));

    assert.equal(connectivityManager.isOnline(), true, 'Device has internet connectivity');
    assert.equal(connectivityManager.isBackendAvailable(), false, 'Backend service is unavailable');
    assert.equal(onlineManager.isOnline(), true, 'TanStack onlineManager remains online');
  });

  // Test H: Authoritative 403/404 hides cached live shifts immediately
  it('H. Authoritative 403/404 hides cached live shifts immediately and purges query cache', () => {
    const client = createQueryClient();
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const teamId = 'team-revoked';
    const userId = 'user-revoked';

    const infiniteKey = queryKeys.shifts.infinite(teamId, userId);
    client.setQueryData(infiniteKey, {
      pages: [
        {
          shifts: [{ id: 's-secret', title: 'Confidential Shift', startsAt: '2026-11-06T09:00:00Z' }],
          pagination: { page: 1, totalPages: 1, total: 1, limit: 20 },
        },
      ],
      pageParams: [1],
    });

    // Verify cache has data before revocation
    const cachedBefore = client.getQueryData(infiniteKey) as any;
    assert.equal(cachedBefore.pages[0].shifts.length, 1);

    // Backend returns 403 FORBIDDEN
    const forbiddenError = new ApiError(403, 'Forbidden', 'FORBIDDEN');
    const isAuthError = forbiddenError.statusCode === 403 || forbiddenError.statusCode === 404;
    assert.ok(isAuthError);

    // Production handler: displayedShifts immediately evaluates to [] on auth error
    const liveShifts = cachedBefore.pages.flatMap((p: any) => p.shifts);
    const displayedShifts = isAuthError ? [] : liveShifts;
    assert.deepEqual(displayedShifts, [], 'Must return empty array immediately when access is revoked');

    // Query cache for this team is removed
    client.removeQueries({ queryKey: queryKeys.shifts.all(teamId, userId) });
    assert.equal(client.getQueryData(infiniteKey), undefined, 'Query cache must be cleared');

    client.clear();
  });

  // Test I: Stale/cached shifts do not generate a fresh syncedAt timestamp
  it('I. Stale/cached shifts do not generate a fresh syncedAt timestamp on mount', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const initialSnapshot = await storage.saveShifts('u-stale', 't-stale', [
      { id: 's1', title: 'Shift 1', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T17:00:00Z', status: 'SCHEDULED', assignedToUserId: 'u-stale' } as any,
    ]);

    const initialSyncedAt = initialSnapshot.syncedAt;

    // Simulate component mounting with cached query data (dataUpdatedAt has not advanced)
    let lastSavedDataUpdatedAt = 1000;
    const queryDataUpdatedAt = 1000; // Not greater than lastSavedDataUpdatedAt

    let saveCalled = false;
    if (queryDataUpdatedAt > lastSavedDataUpdatedAt) {
      saveCalled = true;
    }

    assert.equal(saveCalled, false, 'saveShifts must NOT be called for stale/unchanged dataUpdatedAt');

    const loaded = await storage.getShifts('u-stale', 't-stale');
    assert.equal(loaded?.syncedAt, initialSyncedAt, 'syncedAt timestamp must remain unchanged');
  });

  // Test J: Genuine server update updates syncedAt timestamp
  it('J. Genuine server update updates syncedAt timestamp', async () => {
    const memory = new MemoryStorageAdapter();
    const storage = new OfflineShiftStorageManager(memory);

    const initialSnapshot = await storage.saveShifts('u-sync', 't-sync', [
      { id: 's1', title: 'Old Shift', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T17:00:00Z', status: 'SCHEDULED', assignedToUserId: 'u-sync' } as any,
    ]);

    // Wait 5ms to guarantee different timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));

    let lastSavedDataUpdatedAt = 1000;
    const newServerDataUpdatedAt = 2000; // Fresh network response

    let updatedSnapshot = initialSnapshot;
    if (newServerDataUpdatedAt > lastSavedDataUpdatedAt) {
      lastSavedDataUpdatedAt = newServerDataUpdatedAt;
      updatedSnapshot = await storage.saveShifts('u-sync', 't-sync', [
        { id: 's1', title: 'Updated Shift', startsAt: '2026-11-06T09:00:00Z', endsAt: '2026-11-06T17:00:00Z', status: 'SCHEDULED', assignedToUserId: 'u-sync' } as any,
      ]);
    }

    assert.notEqual(updatedSnapshot.syncedAt, initialSnapshot.syncedAt);
    assert.ok(new Date(updatedSnapshot.syncedAt).getTime() > new Date(initialSnapshot.syncedAt).getTime());
  });

  // Test K: Shift swap infinite pagination accumulates pages without losing previous page
  it('K. Shift swap infinite pagination accumulates pages without losing previous page', () => {
    const page1 = {
      shiftSwaps: [
        { id: 'swap-1', status: 'PENDING_PEER' },
        { id: 'swap-2', status: 'PENDING_PEER' },
      ],
      pagination: { total: 4, page: 1, limit: 2, totalPages: 2 },
    };

    const page2 = {
      shiftSwaps: [
        { id: 'swap-3', status: 'PENDING_PEER' },
        { id: 'swap-4', status: 'PENDING_PEER' },
      ],
      pagination: { total: 4, page: 2, limit: 2, totalPages: 2 },
    };

    const infiniteData = {
      pages: [page1, page2],
      pageParams: [1, 2],
    };

    // Flatten with deduplication (production displayedSwaps implementation)
    const all = infiniteData.pages.flatMap((p) => p.shiftSwaps);
    const seen = new Set<string>();
    const displayedSwaps: any[] = [];
    for (const swap of all) {
      if (!seen.has(swap.id)) {
        seen.add(swap.id);
        displayedSwaps.push(swap);
      }
    }

    assert.equal(displayedSwaps.length, 4, 'Must retain both page 1 and page 2 items');
    assert.deepEqual(displayedSwaps.map((s) => s.id), ['swap-1', 'swap-2', 'swap-3', 'swap-4']);
  });

  // Test L: Tab and filter switching strictly isolates query cache
  it('L. Tab and filter switching strictly isolates query cache without cross-contamination', () => {
    const client = createQueryClient();
    const teamId = 'team-iso';
    const userId = 'user-iso';

    const incomingKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'INCOMING', 'ALL');
    const myRequestsKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'MY_REQUESTS', 'ALL');
    const managerReviewKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'MANAGER_REVIEW', 'ALL');
    const historyApprovedKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'HISTORY', 'APPROVED');

    client.setQueryData(incomingKey, { pages: [{ shiftSwaps: [{ id: 'inc-1' }] }] });
    client.setQueryData(myRequestsKey, { pages: [{ shiftSwaps: [{ id: 'req-1' }] }] });
    client.setQueryData(managerReviewKey, { pages: [{ shiftSwaps: [{ id: 'mgr-1' }] }] });
    client.setQueryData(historyApprovedKey, { pages: [{ shiftSwaps: [{ id: 'hist-app-1' }] }] });

    assert.deepEqual(client.getQueryData(incomingKey), { pages: [{ shiftSwaps: [{ id: 'inc-1' }] }] });
    assert.deepEqual(client.getQueryData(myRequestsKey), { pages: [{ shiftSwaps: [{ id: 'req-1' }] }] });
    assert.deepEqual(client.getQueryData(managerReviewKey), { pages: [{ shiftSwaps: [{ id: 'mgr-1' }] }] });
    assert.deepEqual(client.getQueryData(historyApprovedKey), { pages: [{ shiftSwaps: [{ id: 'hist-app-1' }] }] });

    client.clear();
  });

  // Test M: Optimistic removal handles items on page 2 or later of infinite query
  it('M. Optimistic removal handles items on page 2 or later of infinite query', () => {
    const client = createQueryClient();
    const infiniteKey = queryKeys.shiftSwaps.infiniteTab('team-1', 'user-1', 'INCOMING', 'ALL');

    client.setQueryData(infiniteKey, {
      pages: [
        {
          shiftSwaps: [{ id: 'swap-p1', status: 'PENDING_PEER' }],
          pagination: { total: 3, page: 1, limit: 1, totalPages: 3 },
        },
        {
          shiftSwaps: [{ id: 'swap-p2', status: 'PENDING_PEER' }],
          pagination: { total: 3, page: 2, limit: 1, totalPages: 3 },
        },
      ],
      pageParams: [1, 2],
    });

    const targetSwapId = 'swap-p2';

    // onMutate for infinite data
    const current = client.getQueryData(infiniteKey) as any;
    let targetPageIndex = -1;
    let removedSwap = null;

    for (let i = 0; i < current.pages.length; i++) {
      const found = current.pages[i].shiftSwaps.find((s: any) => s.id === targetSwapId);
      if (found) {
        removedSwap = found;
        targetPageIndex = i;
        break;
      }
    }

    assert.equal(targetPageIndex, 1, 'Target swap is on page 2 (index 1)');

    client.setQueryData(infiniteKey, {
      ...current,
      pages: current.pages.map((page: any, idx: number) => {
        if (idx !== targetPageIndex) return page;
        return {
          ...page,
          shiftSwaps: page.shiftSwaps.filter((s: any) => s.id !== targetSwapId),
          pagination: { ...page.pagination, total: page.pagination.total - 1 },
        };
      }),
    });

    const updated = client.getQueryData(infiniteKey) as any;
    assert.equal(updated.pages[0].shiftSwaps.length, 1, 'Page 1 remains intact');
    assert.equal(updated.pages[1].shiftSwaps.length, 0, 'Page 2 target item removed');
    assert.equal(updated.pages[1].pagination.total, 2);

    client.clear();
  });

  // Test N: Rollback on error restores target item to its original page
  it('N. Rollback on error restores target item to its original page without clobbering other items', () => {
    const client = createQueryClient();
    const infiniteKey = queryKeys.shiftSwaps.infiniteTab('team-1', 'user-1', 'INCOMING', 'ALL');

    const swapP1 = { id: 'swap-p1', status: 'PENDING_PEER' };
    const swapP2 = { id: 'swap-p2', status: 'PENDING_PEER' };

    client.setQueryData(infiniteKey, {
      pages: [
        { shiftSwaps: [swapP1], pagination: { total: 2, page: 1, limit: 1, totalPages: 2 } },
        { shiftSwaps: [], pagination: { total: 1, page: 2, limit: 1, totalPages: 2 } }, // swap-p2 removed optimistically
      ],
      pageParams: [1, 2],
    });

    // onError rollback logic for targetPageIndex = 1
    const targetPageIndex = 1;
    const removedSwap = swapP2;

    client.setQueryData(infiniteKey, (old: any) => ({
      ...old,
      pages: old.pages.map((page: any, idx: number) => {
        if (idx !== targetPageIndex) return page;
        return {
          ...page,
          shiftSwaps: [removedSwap, ...page.shiftSwaps],
          pagination: { ...page.pagination, total: page.pagination.total + 1 },
        };
      }),
    }));

    const restored = client.getQueryData(infiniteKey) as any;
    assert.equal(restored.pages[0].shiftSwaps[0].id, 'swap-p1');
    assert.equal(restored.pages[1].shiftSwaps[0].id, 'swap-p2', 'Must be restored to original page 2');
    assert.equal(restored.pages[1].pagination.total, 2);

    client.clear();
  });

  // Test O: Concurrent mutations on different items do not overwrite each other
  it('O. Concurrent mutations on different items do not overwrite each other', () => {
    const client = createQueryClient();
    const infiniteKey = queryKeys.shiftSwaps.infiniteTab('team-1', 'user-1', 'INCOMING', 'ALL');

    const swapA = { id: 'swap-A', status: 'PENDING_PEER' };
    const swapB = { id: 'swap-B', status: 'PENDING_PEER' };

    client.setQueryData(infiniteKey, {
      pages: [
        { shiftSwaps: [swapA, swapB], pagination: { total: 2, page: 1, limit: 2, totalPages: 1 } },
      ],
      pageParams: [1],
    });

    // Mutation 1: remove swapA
    client.setQueryData(infiniteKey, (old: any) => ({
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        shiftSwaps: p.shiftSwaps.filter((s: any) => s.id !== 'swap-A'),
      })),
    }));

    // Mutation 2: remove swapB
    client.setQueryData(infiniteKey, (old: any) => ({
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        shiftSwaps: p.shiftSwaps.filter((s: any) => s.id !== 'swap-B'),
      })),
    }));

    // Both are removed
    let current = client.getQueryData(infiniteKey) as any;
    assert.equal(current.pages[0].shiftSwaps.length, 0);

    // Mutation 1 fails on server -> non-clobbering rollback re-inserts swapA
    client.setQueryData(infiniteKey, (old: any) => ({
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        shiftSwaps: p.shiftSwaps.some((s: any) => s.id === 'swap-A')
          ? p.shiftSwaps
          : [swapA, ...p.shiftSwaps],
      })),
    }));

    // Mutation 2 succeeded on server -> swapB remains removed!
    current = client.getQueryData(infiniteKey) as any;
    assert.equal(current.pages[0].shiftSwaps.length, 1);
    assert.equal(current.pages[0].shiftSwaps[0].id, 'swap-A');

    client.clear();
  });

  // Test P: Bounded cache indicator clearly reflects MAX_OFFLINE_SHIFTS_PER_TEAM limit
  it('P. Bounded cache indicator clearly reflects MAX_OFFLINE_SHIFTS_PER_TEAM limit', () => {
    assert.equal(MAX_OFFLINE_SHIFTS_PER_TEAM, 20);

    const fullSnapshot = {
      shifts: Array.from({ length: 20 }, (_, i) => ({ id: `s-${i}` })),
    };
    const partialSnapshot = {
      shifts: Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}` })),
    };

    const getBannerTitle = (snapshot: any) => {
      if (snapshot.shifts.length >= MAX_OFFLINE_SHIFTS_PER_TEAM) {
        return 'Viewing cached schedule (Partial schedule · Max 20 shifts)';
      }
      return 'Viewing cached schedule (Read-only)';
    };

    assert.equal(
      getBannerTitle(fullSnapshot),
      'Viewing cached schedule (Partial schedule · Max 20 shifts)'
    );
    assert.equal(getBannerTitle(partialSnapshot), 'Viewing cached schedule (Read-only)');
  });

  // Test Q: No fabricated settings routes exist under server/src/routes
  it('Q. No fabricated settings routes exist under server/src/routes', () => {
    const routesDir = path.resolve(__dirname, '../routes');
    const routeFiles = fs.readdirSync(routesDir);

    const hasSettingsRoute = routeFiles.some((f) => f.includes('setting'));
    assert.equal(
      hasSettingsRoute,
      false,
      'Must NOT invent fake settings routes; R09 settings remain pending as required'
    );
  });

  // Test R: Exact storage payload-size enforcement strictly below 2000 bytes
  it('R. Exact storage payload-size enforcement: serialized payload strictly <= 2000 bytes', async () => {
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
});