# ROTA — TASK R06B, R06B.1 & R06B.2 EVIDENCE
## Offline Cache Security, Real Connectivity, Native Network Integration & Swap Pagination Hardening

**Repository:** `C:\Users\USER\rota-mobile`  
**Verified Starting Baseline:** `163a39c44dc5ada589a8186c2471485402b089c1`  
**Requirements Addressed:** R06.2, R06.3, R06.4, R06.5  
**Evaluation Dimensions:** Impl: YES | Test: YES | Dep: NO | Evid: YES  
**Status Result:** PARTIAL (Awaiting production deployment & physical Android device airplane mode validation)  

---

### 1. Mandatory Pagination Safety & Cross-Team Isolation

- **Identified Flaw:** Screen components (`app/src/app/(app)/index.tsx` and `members.tsx`) previously stored paginated records in component-level `useState` and attempted to wipe them in a `useEffect` on `selectedTeam?.id` change. This caused a transient cross-team or cross-filter rendering flash where Team A records appeared under Team B's heading before the effect ran.
- **Migration to `useInfiniteQuery`:**
  - Added infinite query keys in `queryKeys.ts`: `shifts.infinite(teamId, userId, params)` and `members.infinite(teamId, userId, params)`.
  - Created typed hooks: `useInfiniteShifts(teamId, userId, params)` and `useInfiniteTeamMembers(teamId, userId, limit)`.
  - Both screens derive records directly from TanStack Query cache: `data.pages.flatMap(...)` with `Set`-based ID deduplication.
  - Eliminated component-level accumulated state and their clearing `useEffect` hooks entirely.
  - When switching teams or filters, the query key changes immediately, rendering clean skeletons/empty states without flashing prior team or filter records.

---

### 2. Offline Storage Security & Recoverable Cleanup (Tasks R06B.1 & R06B.2)

- **Index-First Persistence Pre-Allocation:**
  - `OfflineShiftStorageManager.saveShifts(userId, teamId, shifts)` now writes `teamId` to the user's index registry (`rota.offline-shifts.index.${userId}`) *before* persisting the snapshot to storage. If the index update fails, the operation throws immediately and the snapshot write is never initiated, guaranteeing zero untracked orphan snapshots.
- **Recoverable Partial Deletion:**
  - In `clearUserShifts(userId, knownTeamIds)`, if any team snapshot fails to delete, the failed team IDs are preserved in the user index rather than wiping the index. A subsequent retry or sign-out retains full knowledge of which snapshots remain to be cleaned up.
- **Independent Credential Wipe in `AuthContext`:**
  - In `AuthContext.clearCredentials()`, offline shift deletion is isolated in its own try/catch block. Deletion of the refresh token, selected team, and session metadata from `SecureStore` always executes even if offline storage cleanup encounters an unexpected error.
- **Strict Byte-Size Boundary (< 2000 Bytes):**
  - Enforced measured UTF-8 byte-length (`getUtf8ByteLength(serialized)`). Titles are truncated to 40 characters and assigned names to 30 characters. If the serialized snapshot exceeds `MAX_OFFLINE_PAYLOAD_BYTES = 2000`, older shifts are iteratively pruned until the payload strictly fits under 2000 bytes.
- **Authoritative 403 / 404 Access Revocation:**
  - When `shiftsQuery` encounters an HTTP 403 (FORBIDDEN) or 404 (NOT_FOUND), `displayedShifts` immediately evaluates to `[]`.
  - The query cache for the revoked team is purged via `queryClient.removeQueries({ queryKey: queryKeys.shifts.all(teamId, userId) })`.
  - The offline snapshot is deleted via `offlineShiftStorage.clearTeamShifts(userId, teamId)` and the offline banner suppressed, rendering an explicit access revoked state.
- **True Server Synchronization Timestamp Semantics:**
  - `syncedAt` timestamps are only created/updated when TanStack Query's `dataUpdatedAt` genuinely advances past `lastSavedDataUpdatedAtRef.current` following a fresh, successful server response for the team's unfiltered schedule (`statusFilter === 'ALL' && !filterDate`). Merely mounting offline or reading from cached queries never advances `syncedAt`.
- **Bounded Offline Schedule Clarification:**
  - When the offline snapshot holds `MAX_OFFLINE_SHIFTS_PER_TEAM = 20` shifts, the offline banner clearly displays: `'Viewing cached schedule (Partial schedule · Max 20 shifts)'`.

---

### 3. Native Network Event Integration & Lifecycle (Task R06B.2)

- **`@react-native-community/netinfo` Integration:**
  - Installed version `12.0.1` cleanly into `app/package.json`.
  - Integrated via lazy module loader `getNetInfo()` in `app/src/services/network/connectivityManager.ts`, allowing unit tests and headless environments to run without native binary bindings.
  - Listens to real-time native network transitions (e.g. flipping Airplane Mode or toggling Wi-Fi while the application remains active).
  - When `state.isConnected === false`, immediately marks the device offline and updates `onlineManager.setOnline(false)` without waiting for health probe timeouts.
  - When `state.isConnected === true` and `state.isInternetReachable !== false`, immediately verifies connectivity via `checkConnectivity()`.
- **Distinction Between Device Offline and Backend Unavailable:**
  - Device network failures (`TypeError`, `AbortError`, timeout) transition device to offline (`isOnline = false, backendAvailable = false`).
  - Backend errors (HTTP 500 on `/health`) keep `isOnline = true` while setting `backendAvailable = false`, ensuring TanStack Query does not falsely classify server downtime as device disconnection.
- **Clean Teardown:**
  - `setupNetworkConnectivity(AppState)` wired in `_layout.tsx` returns a combined teardown function that deregisters both NetInfo and AppState listeners on unmount.

---

### 4. Shift Swap Infinite Pagination & Optimistic Updates (Task R06B.2)

- **Infinite Query for Swap Lists:**
  - Implemented `useInfiniteShiftSwapsTab(teamId, userId, activeTab, historyFilter)` in `app/src/services/query/hooks/useShiftSwapsQuery.ts`.
  - Hierarchical query key: `queryKeys.shiftSwaps.infiniteTab(teamId, userId, activeTab, historyFilter)`.
  - `shift-swaps.tsx` derives `displayedSwaps` directly from `data.pages.flatMap(...)` with ID deduplication.
  - "Load more" invokes `fetchNextPage()`, accumulating subsequent pages into the cache without replacing or discarding earlier pages.
- **Multi-Page Optimistic Updates:**
  - In `useOptimisticSwapMutations.ts` (`useOptimisticSwapRespond`, `useOptimisticSwapReview`, `useOptimisticSwapCancel`):
    - `onMutate` searches across all loaded pages of `InfiniteData<ShiftSwapsTabResult>` to find the target swap regardless of which page it resides on.
    - Captures `removedSwap` and `targetPageIndex`.
    - Optimistically removes the target swap from the specific page and decrements the page total.
    - Captures query cache snapshots for rollback.
- **Non-Clobbering Multi-Page Rollback:**
  - On mutation failure (`onError`), re-inserts `removedSwap` into its exact original page index in `InfiniteData<ShiftSwapsTabResult>` without wiping or clobbering other concurrent mutations.
- **Authoritative Invalidation:**
  - On settlement (`onSettled`), invalidates `queryKeys.shiftSwaps.all` and `queryKeys.shifts.all` to synchronize with authoritative backend state.

---

### 5. Settings Mutation Boundary & Strict Realism Disclosure

- **Backend Route Reality:** Server routes inspectable under `server/src/routes/` contain `/auth`, `/teams`, `/shifts`, `/shift-swaps`, `/activity`, and `/billing`.
- **Zero Fake Endpoints:** There is **no backend route or schema for user settings** (tracked under future graduation criterion R09).
- **Strict Realism:** No fake settings routes or mock controllers were fabricated. R06.4 is satisfied for shift swap operations and documented as `PARTIAL` pending future R09 settings implementation.

---

### 6. Executable Test Suite Results

#### Test Suite 1: R06B.2 Offline Security, Native Network & Swap Pagination (`server/src/teams/offline-and-optimistic.test.ts`)
Executed via `npx tsx --test server/src/teams/offline-and-optimistic.test.ts`:

```
▶ R06B.2: Final Offline Security, Native Network & Swap Pagination Hardening
  ✔ A. Index-write failure does not leave an untracked snapshot: snapshot write aborted if index update fails (32.1781ms)
  ✔ B. Partial deletion failure retains retry information in index for failed teams (14.2006ms)
  ✔ C. Credential cleanup continues even if offline deletion throws (3.5471ms)
  ✔ D. Multiple team snapshots cleared correctly across multiple workspaces (5.5072ms)
  ✔ E. Native network events: airplane mode triggers offline immediately without waiting for probe timeout (3.2131ms)
  ✔ F. Native reconnection: isConnected + isInternetReachable triggers connectivity verification (4.5944ms)
  ✔ G. Backend 500 error does NOT mark device as offline: distinguishes offline from backend down (2.0207ms)
  ✔ H. Authoritative 403/404 hides cached live shifts immediately and purges query cache (16.569ms)
  ✔ I. Stale/cached shifts do not generate a fresh syncedAt timestamp on mount (2.0101ms)
  ✔ J. Genuine server update updates syncedAt timestamp (43.5794ms)
  ✔ K. Shift swap infinite pagination accumulates pages without losing previous page (2.043ms)
  ✔ L. Tab and filter switching strictly isolates query cache without cross-contamination (4.5011ms)
  ✔ M. Optimistic removal handles items on page 2 or later of infinite query (3.1613ms)
  ✔ N. Rollback on error restores target item to its original page without clobbering other items (2.7047ms)
  ✔ O. Concurrent mutations on different items do not overwrite each other (3.5836ms)
  ✔ P. Bounded cache indicator clearly reflects MAX_OFFLINE_SHIFTS_PER_TEAM limit (1.1653ms)
  ✔ Q. No fabricated settings routes exist under server/src/routes (2.6323ms)
  ✔ R. Exact storage payload-size enforcement: serialized payload strictly <= 2000 bytes (3.5701ms)
✔ R06B.2: Final Offline Security, Native Network & Swap Pagination Hardening (167.6569ms)
ℹ tests 18
ℹ suites 1
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3846.0065
```

#### Test Suite 2: R06A TanStack Query Foundation (`server/src/teams/tanstack-query-foundation.test.ts`)
Executed via `npx tsx --test server/src/teams/tanstack-query-foundation.test.ts`:
- **15 passed, 0 failed**

#### Test Suite 3: Mobile Invitation Logic (`server/src/teams/mobile-invitation-logic.test.ts`)
Executed via `npx tsx --test server/src/teams/mobile-invitation-logic.test.ts`:
- **30 passed, 0 failed**

#### Typecheck Verification:
- `cd app; npx tsc --noEmit`: **0 errors**
- `cd server; npm run typecheck`: **0 errors**

---

### 7. Remaining Gaps to Close Requirement R06

1. **Physical Device Verification:** Test offline mode and reconnection on physical Android hardware in Airplane Mode. Note: Offline app restart requires successful session/refresh token restoration from SecureStore.
2. **Production Deployment & Standalone Build:** Compile an updated standalone EAS build (`apk`) and deploy updated backend routes to Vercel production.
3. **Settings Optimistic Updates:** Implement optimistic updates for user settings when R09 settings schema and endpoints are built.
