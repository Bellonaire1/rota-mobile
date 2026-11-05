# ROTA — TASK R06B & R06B.1 EVIDENCE
## Offline Cache Security, Real Connectivity & Optimistic UI Workflows

**Repository:** `C:\Users\USER\rota-mobile`  
**Verified Baseline:** `fd1c31eef8ba86718de68cb33002487f2eda2432`  
**Requirements Addressed:** R06.2, R06.3, R06.4  
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

### 2. Bounded Offline Shift Storage & Sign-Out Cleanup Hardening (Task R06B.1)

- **Team Registry Discovery for Zero-Parameter Sign-Out Cleanup:**
  - **Identified Flaw:** `clearUserShifts(userId)` previously only removed keys for teams provided in an optional `knownTeamIds` parameter. Because `AuthContext.clearCredentials()` passed no team IDs, sign-out left all persisted offline shifts on the device.
  - **Correction:** Implemented `getOfflineTeamIndexKey(userId)` registry key (`rota.offline-shifts.index.${userId}`). When `saveShifts` saves a snapshot for any team, it automatically records the `teamId` in the user's registry.
  - `clearUserShifts(userId)` now discovers all historical teams the user ever visited, deletes every snapshot key, deletes the index itself, and explicitly catches and reports any storage deletion failures rather than falsely claiming success.
- **Measured Byte-Size Boundary (< 2000 Bytes):**
  - **Identified Flaw:** Assuming 20 records always serialize below 2048 bytes was unsafe for long titles, descriptions, and user names.
  - **Correction:** Enforced measured UTF-8 byte-length (`getUtf8ByteLength(serialized)`). Titles are truncated to 40 characters and assigned names to 30 characters. If the serialized snapshot exceeds `MAX_OFFLINE_PAYLOAD_BYTES = 2000`, older shifts are iteratively pruned until the payload strictly fits under 2000 bytes.
- **Storage Write Failure Detection:**
  - `SecureStoreAdapter` and `saveShifts` propagate storage errors rather than silently swallowing them. If secure storage is full or fails, an exception is thrown and the failure is handled gracefully without falsely reporting successful persistence.
- **Snapshot Isolation During Render & Filter Correctness:**
  - Synchronously clears loaded `offlineSnapshot` during the render phase if `selectedTeam?.id` changes, preventing Team A snapshots from rendering under Team B before effects execute.
  - Offline snapshots are filtered strictly against the active `statusFilter` and `filterDate`. An unfiltered snapshot is never presented as if it satisfies a specific status or date filter.
  - Authoritative HTTP 403/404 errors wipe the team's offline cache immediately via `clearTeamShifts(userId, teamId)` and suppress offline rendering.
- **True Server Synchronization Timestamp Semantics:**
  - `syncedAt` timestamps are only created/updated upon genuine successful server fetch responses for the team's general schedule (`statusFilter === 'ALL' && !filterDate`). Merely reading data from the offline cache or TanStack Query cache never advances the timestamp.

---

### 3. Real Network Connectivity & Lifecycle Integration (Task R06B.1)

- **Identified Flaw:** `connectivityManager.checkConnectivity()` existed as an isolated helper but was never wired into the application root or lifecycle. The manager initialized `online = true`, meaning the app would never detect airplane mode on startup or foreground transitions.
- **Correction:**
  - Created `setupNetworkConnectivity(appStateSource)` in `app/src/services/network/connectivityManager.ts`.
  - Wired into `RootLayout` (`app/src/app/_layout.tsx`) alongside `setupQueryFocusManager`.
  - Executes an immediate real network probe at application startup.
  - Listens to React Native `AppState` change events to re-probe connectivity whenever the application transitions to `active` (foreground).
  - Listens to web `online` and `offline` window events when running on Web.
  - Distinguishes device network connectivity from backend server availability: network transport errors (`TypeError`, `AbortError`, timeout) transition device to offline (`isOnline = false`), while HTTP 5xx responses indicate device is online but backend is unavailable (`isOnline = true, backendAvailable = false`).
  - Automatically synchronizes TanStack Query's `onlineManager.setOnline(isOnline)` and notifies all reactive subscribers.

---

### 4. Visible Optimistic Swap Mutations & Rollback Architecture (Task R06B.1)

- **Identified Flaw:** `shift-swaps.tsx` previously kept swaps in a component-level `useState` array populated by a manual `loadSwaps()` function. Optimistic mutations updated the TanStack Query cache, but because the visible list did not observe that cache, optimistic updates had no effect on the visible list. Furthermore, `useOptimisticSwapCancel` lacked a genuine optimistic cache update and rollback.
- **Correction:**
  - Created typed TanStack Query hooks in `app/src/services/query/hooks/useShiftSwapsQuery.ts`:
    - `useShiftSwapsTab(teamId, userId, activeTab, historyFilter, page)`: drives the visible swap list directly from the query cache.
    - `useShiftSwapsTabCounts(teamId, userId)`: drives the tab badge counts directly from the query cache.
    - `useShiftSwapRole(teamId, userId)`: caches the user's role in the active team.
  - Migrated `app/src/app/(app)/shift-swaps.tsx` to use these hooks, removing manual `swaps` state and `loadSwaps()`.
  - Hardened `useOptimisticSwapMutations.ts`:
    - `useOptimisticSwapRespond`: `onMutate` immediately removes the swap from the visible `INCOMING` tab and decrements `incoming` badge count.
    - `useOptimisticSwapReview`: `onMutate` immediately removes the swap from the visible `MANAGER_REVIEW` tab and decrements `managerReview` badge count.
    - `useOptimisticSwapCancel`: `onMutate` immediately removes the swap from the visible `MY_REQUESTS` tab and decrements `myRequests` badge count.
  - **Non-Clobbering Rollback:** On error (network failure, HTTP 409 conflict, or HTTP 403 authorization failure), `onError` re-inserts the specific failed swap into the current cache if missing and restores badge counts, without wiping or clobbering concurrent mutations that succeeded.
  - `onSettled` invalidates `queryKeys.shiftSwaps.all` and `queryKeys.shifts.all` to reconcile with authoritative server state.

---

### 5. Settings Mutation Boundary & Strict Realism Disclosure

- **Backend Route Reality:** Server routes inspectable under `server/src/routes/` contain `/auth`, `/teams`, `/shifts`, `/shift-swaps`, `/activity`, and `/billing`.
- **Zero Fake Endpoints:** There is **no backend route or schema for user settings** (tracked under future graduation criterion R09).
- **Strict Realism:** No fake settings routes or mock controllers were fabricated. R06.4 is satisfied for shift swap operations and documented as `PARTIAL` pending future R09 settings implementation.

---

### 6. Executable Test Suite Results

#### Test Suite 1: R06B.1 Offline Cache Security & Optimistic Workflows (`server/src/teams/offline-and-optimistic.test.ts`)
Executed via `npx tsx --test server/src/teams/offline-and-optimistic.test.ts`:

```
▶ R06B.1: Offline Cache Security, Real Connectivity & Optimistic UI Workflows
  ✔ A. Sign-out cleanup with NO explicit team IDs: index discovers and clears all user data (7.11ms)
  ✔ B. Cleanup of multiple previously visited teams: wipes all historical teams for user (1.1277ms)
  ✔ C. Failed deletion is detectable: storage failure bubbles and is not reported as success (1.685ms)
  ✔ D. Real connectivity initialization: lifecycle setup triggers initial probe and listener (273.1098ms)
  ✔ E. Online to airplane-mode transition: network failure transitions to offline (45.751ms)
  ✔ F. Airplane-mode to online reconnection: successful probe restores online state (1.4611ms)
  ✔ G. Exact storage payload-size enforcement: serialized payload strictly below 2000 bytes (1.9519ms)
  ✔ H. Oversized payload handling: truncates titles and safely prunes records to stay within byte boundary (1.9118ms)
  ✔ I. Secure storage write failure: write error throws and is not falsely reported as success (0.658ms)
  ✔ J. Cross-team offline snapshot state isolation: Team A data is never returned for Team B (0.6887ms)
  ✔ K. Authorization failure prevents stale display: 403 wipes cache and prevents rendering (0.5716ms)
  ✔ L. Offline date/status filter correctness: does not present unfiltered snapshot as matching filtered query (0.3897ms)
  ✔ M. True server-sync timestamp semantics: timestamp only recorded on genuine server save (0.4714ms)
  ✔ N. Visible swap list updates before server response: onMutate optimistically removes item from visible tab (3.5972ms)
  ✔ O. Failed peer response rolls back visibly: error re-inserts removed swap and restores count (1.3241ms)
  ✔ P. Failed manager review rolls back visibly: manager approve/reject rolls back on network error (1.0527ms)
  ✔ Q. Cancel action updates visibly and rolls back: requester cancellation updates cache and restores on error (0.8646ms)
  ✔ R. Concurrent mutations do not corrupt state: rollback of action 1 preserves action 2 (1.4796ms)
  ✔ S. Tab pagination and badge counts remain consistent: multi-tab counts reflect accurate totals (0.7745ms)
  ✔ T. No fabricated endpoints: verifies no settings routes were fabricated in backend (1.8303ms)
✔ R06B.1: Offline Cache Security, Real Connectivity & Optimistic UI Workflows (352.5585ms)
ℹ tests 20
ℹ suites 1
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3004.0949
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
