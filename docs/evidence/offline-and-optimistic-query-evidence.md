# ROTA — TASK R06B, R06B.1, R06B.2 & R06C EVIDENCE
## Offline Cache Security, Real Connectivity, Native Network Integration, Swap Pagination & Android Readiness

**Repository:** `C:\Users\USER\rota-mobile`  
**Verified Starting Baseline:** `3d38c468a8942c9d86f84e353532fac53b8e03b0`  
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

### 2. Offline Storage Security & Recoverable Cleanup (Tasks R06B.1, R06B.2 & R06C)

- **Index Mutex Serialization Lock (`withUserIndexLock`):**
  - Implemented an asynchronous per-user mutex lock queue in `OfflineShiftStorageManager`. Concurrent `saveShifts()` calls for different teams belonging to the same user are strictly serialized, eliminating race conditions that previously dropped index registry entries.
- **Session Clearance Tracking (`markSessionCleared` / `setSessionActive`):**
  - Integrated explicit session state tracking into `OfflineShiftStorageManager`. On user sign-out (`AuthContext.clearCredentials()`), `markSessionCleared(userId)` is triggered immediately. Any in-flight background query resolving after sign-out is rejected with an explicit error, preventing orphaned or unencrypted post-signout snapshot persistence. Login and session restore re-enable persistence via `setSessionActive(userId)`.
- **Index Read Failure Protection:**
  - In `clearUserShifts(userId, knownTeamIds)`, if reading the user index key throws a storage read error, the index key is **not** overwritten with an empty array or destroyed. The disk key is preserved, an error is reported, and any subsequent retry can read the existing index and complete full multi-workspace cleanup.
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
- **Accurate Per-Team Server Synchronization Timestamp Semantics:**
  - Tracked via `lastSavedDataUpdatedAtByTeamRef = useRef<Record<string, number>>({})` in `index.tsx`. Switching between workspaces retains each team's last known synchronization timestamp without reset. Mounting offline, switching teams, or viewing cached queries never advances `syncedAt`. Timestamps advance only when a fresh, successful server response genuinely advances `shiftsDataUpdatedAt > lastSavedDataUpdatedAtByTeamRef.current[teamId]`.
- **Explicit Partial Schedule Labeling & Reason Tracking:**
  - `OfflineShiftSnapshot` includes `isPartial: boolean`, `partialReason?: 'BYTE_LIMIT' | 'MAX_RECORDS_REACHED' | 'MORE_PAGES_EXIST'`, and `totalServerCount?: number`.
  - The offline banner dynamically reflects schedule completeness:
    - Complete: `'Viewing cached schedule (Complete schedule · Read-only)'`
    - More pages on server: `'Viewing cached schedule (Partial schedule · More shifts on server)'`
    - Max records reached: `'Viewing cached schedule (Partial schedule · Max 20 shifts)'`
    - Storage byte limit pruned: `'Viewing cached schedule (Partial schedule · Storage limit)'`

---

### 3. Native Network Event Integration & Lifecycle (Tasks R06B.2 & R06C)

- **`@react-native-community/netinfo` Integration:**
  - Installed version `12.0.1` cleanly into `app/package.json`.
  - Integrated via lazy module loader `getNetInfo()` in `app/src/services/network/connectivityManager.ts`, allowing unit tests and headless environments to run without native binary bindings.
  - Listens to real-time native network transitions (e.g. flipping Airplane Mode or toggling Wi-Fi while the application remains active).
  - When `state.isConnected === false`, immediately marks the device offline and updates `onlineManager.setOnline(false)` without waiting for health probe timeouts.
  - When `state.isConnected === true` and `state.isInternetReachable !== false`, immediately verifies connectivity via `checkConnectivity()`.
- **In-Flight Health Probe Race Condition Prevention (`currentGeneration`):**
  - Added monotonic generation counter (`currentGeneration`) in `ConnectivityManager`.
  - When native NetInfo reports an offline event (e.g. user toggles airplane mode), `currentGeneration` increments.
  - Any in-flight health probe initiated prior to the offline event discards its HTTP 200 response upon completion if its capture generation does not match `currentGeneration`. This guarantees an in-flight probe cannot falsely reset an airplane-mode device back to online.
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

#### Test Suite 1: R06B.2 & R06C Offline Security, Network Invariants & Swap Pagination (`server/src/teams/offline-and-optimistic.test.ts`)
Executed via `.\node_modules\.bin\tsx --test src/teams/offline-and-optimistic.test.ts`:

```
▶ R06B.2: Final Offline Security, Native Network & Swap Pagination Hardening
  ✔ A. Index-write failure does not leave an untracked snapshot: snapshot write aborted if index update fails (13.9576ms)
  ✔ B. Partial deletion failure retains retry information in index for failed teams (4.4999ms)
  ✔ C. Credential cleanup continues even if offline deletion throws (5.9004ms)
  ✔ D. Multiple team snapshots cleared correctly across multiple workspaces (2.5832ms)
  ✔ E. Native network events: airplane mode triggers offline immediately without waiting for probe timeout (1.7534ms)
  ✔ F. Native reconnection: isConnected + isInternetReachable triggers connectivity verification (1.3534ms)
  ✔ G. Backend 500 error does NOT mark device as offline: distinguishes offline from backend down (0.5034ms)
  ✔ H. Authoritative 403/404 hides cached live shifts immediately and purges query cache (4.5689ms)
  ✔ I. Stale/cached shifts do not generate a fresh syncedAt timestamp on mount (0.6989ms)
  ✔ J. Genuine server update updates syncedAt timestamp (22.2411ms)
  ✔ K. Shift swap infinite pagination accumulates pages without losing previous page (1.0807ms)
  ✔ L. Tab and filter switching strictly isolates query cache without cross-contamination (2.4179ms)
  ✔ M. Optimistic removal handles items on page 2 or later of infinite query (1.075ms)
  ✔ N. Rollback on error restores target item to its original page without clobbering other items (0.8943ms)
  ✔ O. Concurrent mutations on different items do not overwrite each other (1.2624ms)
  ✔ P. Bounded cache indicator clearly reflects MAX_OFFLINE_SHIFTS_PER_TEAM limit (0.4305ms)
  ✔ Q. No fabricated settings routes exist under server/src/routes (1.0516ms)
  ✔ R. Exact storage payload-size enforcement: serialized payload strictly <= 2000 bytes (1.2347ms)
✔ R06B.2: Final Offline Security, Native Network & Swap Pagination Hardening (72.8993ms)
▶ R06C: Final R06 Correctness Gate and Android Test Readiness
  ✔ A. Failed index read does not wipe or corrupt index; error is reported and index key is preserved on disk for retry (1.183ms)
  ✔ B. Concurrent saves for different teams of same user retain all team entries in index (serialization lock) (0.6003ms)
  ✔ C. Failed cleanup followed by successful retry cleans up preserved failed teams (1.2491ms)
  ✔ D. Session clearance prevents background writes after sign-out, while login reactivates storage (1.7666ms)
  ✔ E. Dashboard remount with cached query data does not advance syncedAt (1.4144ms)
  ✔ F. Genuine new server response advances sync timestamp (1.3257ms)
  ✔ G. Partial snapshot labeling accurately labels completeness and partial reasons (2.684ms)
  ✔ H. In-flight health probe racing NetInfo offline event is discarded and does not set app to online (0.4403ms)
  ✔ I. Multi-tenant workspace and account isolation is strictly maintained (0.8339ms)
  ✔ J. Multi-page swap functionality remains intact with infinite accumulation and page-aware optimistic mutation (1.0756ms)
✔ R06C: Final R06 Correctness Gate and Android Test Readiness (13.6599ms)
ℹ tests 28
ℹ suites 2
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1866.4788
```

#### Test Suite 2: R06A TanStack Query Foundation (`server/src/teams/tanstack-query-foundation.test.ts`)
Executed via `.\node_modules\.bin\tsx --test src/teams/tanstack-query-foundation.test.ts`:
- **15 passed, 0 failed** (15/15)

#### Test Suite 3: Mobile Invitation Logic (`server/src/teams/mobile-invitation-logic.test.ts`)
Executed via `.\node_modules\.bin\tsx --test src/teams/mobile-invitation-logic.test.ts`:
- **30 passed, 0 failed** (30/30)

#### Combined Execution:
Executed via `.\node_modules\.bin\tsx --test src/teams/offline-and-optimistic.test.ts src/teams/tanstack-query-foundation.test.ts src/teams/mobile-invitation-logic.test.ts`:
- **73 passed, 0 failed, 0 skipped** (4 suites, 73 tests)

#### Typecheck Verification:
- `cd app; npx tsc --noEmit`: **0 errors**
- `cd server; npm run typecheck`: **0 errors**

---

### 7. Android Device Test Readiness & 12-Step Test Procedure

#### Android Compatibility Findings:
1. **Expo SDK Version:** Expo SDK `~52.0.28` (`react-native: 0.76.6`) configured in `app/package.json`.
2. **Native NetInfo Dependency:** `@react-native-community/netinfo: 12.0.1` installed and configured. Requires a standalone EAS native build (`buildType: apk`) or development build to link native Android broadcast receivers; standard Expo Go cannot link custom native binary modules.
3. **Hardware Storage:** Uses `expo-secure-store` backed by Android Keystore with AES-GCM encrypted SharedPreferences for persisted credentials and offline snapshots.
4. **Offline Restart Caveat:** When testing offline app restart on a physical device, the user must have already signed in while online so that credentials and refresh tokens exist in SecureStore to restore authentication on launch.

#### 12-Step Physical Android Device Test Procedure:
```powershell
# 1. Build Standalone Preview APK (runs via EAS cloud build)
cd C:\Users\USER\rota-mobile\app
npx eas-cli build --platform android --profile preview

# 2. Download and install the generated APK on your Android device (e.g. via adb or direct download)
adb install -r rota-mobile-preview.apk

# 3. Launch Rota app on the device with active Wi-Fi / cellular data.
# 4. Sign in with valid credentials (e.g., owner@example.com).
# 5. Select a team with scheduled shifts (e.g., "Engineering Team").
# 6. Verify dashboard displays shifts, no offline banner appears, and management buttons ("Add shift") are active.
# 7. Pull down to refresh to ensure shiftsDataUpdatedAt is populated.
# 8. Enable AIRPLANE MODE on the Android device (disables Wi-Fi and mobile network).
# 9. Verify the UI immediately displays the OFFLINE MODE banner without app restart or delay:
#    - Banner title: "Viewing cached schedule (Complete schedule · Read-only)" or bounded partial reason.
#    - Timestamp: "Last synchronized: [Time] · [Date]".
#    - Management actions ("Add shift", edit, cancel) are disabled or show offline notification on tap.
# 10. Close the app completely from the Android app switcher (kill process) and re-open while STILL in Airplane Mode.
# 11. Verify the app restores session from SecureStore, remains in OFFLINE MODE, and renders the cached shifts.
# 12. Disable AIRPLANE MODE (re-enable Wi-Fi / data):
#     - Verify the banner clears automatically upon reconnection.
#     - Verify pulling down to refresh successfully synchronizes live shifts and updates the sync timestamp.
```

---

### 8. Remaining Gaps to Close Requirement R06

1. **Physical Device Verification:** Execute the 12-step test on physical Android hardware.
2. **Production Deployment & Standalone Build:** Compile an updated standalone EAS build (`apk`) and deploy updated backend routes to Vercel production.
3. **Settings Optimistic Updates:** Implement optimistic updates for user settings when R09 settings schema and endpoints are built.
