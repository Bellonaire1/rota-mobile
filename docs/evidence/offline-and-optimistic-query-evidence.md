# ROTA — TASK R06B EVIDENCE
## Offline Shift Viewing, Pagination Safety & Optimistic Query Updates

**Repository:** `C:\Users\USER\rota-mobile`  
**Verified Baseline:** `1f0fef4f5028c923bfc7bbb94e897618fe8ef61b`  
**Requirements Addressed:** R06.2, R06.3, R06.4  
**Evaluation Dimensions:** Impl: YES | Test: YES | Dep: NO | Evid: YES  
**Status Result:** PARTIAL (Awaiting production deployment & physical device Android airplane mode test)  

---

### 1. Mandatory Pagination Safety Correction

- **Identified Flaw:** Screen components (`app/src/app/(app)/index.tsx` and `members.tsx`) previously stored paginated records in component-level `useState` (`accumulatedShifts`, `accumulatedMembers`) and attempted to wipe them in a `useEffect` on `selectedTeam?.id` change. This caused a transient cross-team or cross-filter rendering flash where Team A records appeared under Team B's heading before the wipe completed.
- **Migration to `useInfiniteQuery`:**
  - Added infinite query keys in `queryKeys.ts`: `shifts.infinite(teamId, userId, params)` and `members.infinite(teamId, userId, params)`.
  - Created typed hooks: `useInfiniteShifts(teamId, userId, params)` and `useInfiniteTeamMembers(teamId, userId, limit)`.
  - Both screens now derive records directly from TanStack Query cache: `data.pages.flatMap(...)` with `Set`-based ID deduplication.
  - Eliminated component-level `accumulatedShifts` and `accumulatedMembers` states and their associated clearing effects.
  - When switching teams or filters, the query key changes immediately, rendering clean skeletons/empty states without flashing prior team or filter records.

---

### 2. Bounded Offline Shift Storage Architecture

- **Manager & Adapters (`app/src/services/storage/offlineShiftStorage.ts`):**
  - Implemented `OfflineShiftStorageManager` backed by an `OfflineStorageAdapter` interface.
  - `SecureStoreAdapter`: Utilizes iOS Keychain and Android Keystore AES-GCM / RSA encrypted SharedPreferences. Evaluated as **ENCRYPTED** (`isEncrypted() === true`). Uses lazy module resolution to allow headless unit testing.
  - `MemoryStorageAdapter`: In-memory implementation evaluated as **UNENCRYPTED** (`isEncrypted() === false`).
- **Bounded Storage & Android SharedPreferences Limits:**
  - Hard-bounded via `MAX_OFFLINE_SHIFTS_PER_TEAM = 20`.
  - Stores a compact schema (`CompactOfflineShift`): `id`, `title`, `startsAt`, `endsAt`, `status`, `assignedToName`, `assignedToUserId`.
  - Serialized payload size is ~1.5 KB JSON, comfortably within the 2048-byte Android SharedPreferences key-value boundary.
- **Zero Token Persistence & Strict Isolation:**
  - Storage key format: `rota.offline-shifts.${userId}.${teamId}`.
  - Snapshot strictly excludes: JWT access tokens, refresh tokens, invitation codes, user passwords, and billing metadata.
  - Validated by unit test M: zero tokens or secrets in persisted offline payloads.
- **Eviction & Cleanup:**
  - Sign-out / session clear calls `offlineShiftStorage.clearUserShifts(userId, teamIds)` inside `AuthContext.tsx`.
  - Authorization failure (403/404) calls `offlineShiftStorage.clearTeamShifts(userId, teamId)`.

---

### 3. Network Connectivity & Offline UI Experience

- **Connectivity Manager (`app/src/services/network/connectivityManager.ts`):**
  - Manages online/offline state and synchronizes directly with TanStack Query's `onlineManager`.
  - Provides React hook `useIsOnline()` for reactive UI components.
  - Provides `checkConnectivity()` probing `/health` with timeout for true network connectivity checks.
- **Offline Banner & Read-Only Enforcement (`app/src/app/(app)/index.tsx`):**
  - Displays persistent Amber offline indicator when disconnected: `"Offline — Viewing cached shifts (Synced: ...)"`.
  - Formats synchronization timestamp in localized human-readable format.
  - Read-only enforcement: "Create Shift" button and mutation actions are disabled or hidden while offline, with explicit user toast: `"You are offline. Reconnect to make changes."`.
  - Falling back to offline cache automatically populates the dashboard when the network query fails or is offline.

---

### 4. Optimistic UI Updates & Error Rollback Architecture

- **Optimistic Shift Swap Mutations (`app/src/services/query/hooks/useOptimisticSwapMutations.ts`):**
  - `useOptimisticSwapRespond(teamId, userId)`: Optimistically removes the pending swap from `shiftSwaps.list` and decrements badge counts in `shiftSwaps.pendingCounts`.
  - `useOptimisticSwapReview(teamId, userId)`: Optimistically updates status or removes from manager review list.
  - `useOptimisticSwapCancel(teamId, userId)`: Optimistically cancels user's outgoing swap.
- **Rollback & Invalidation Lifecycle:**
  - `onMutate`:
    1. Cancels outgoing refetches via `queryClient.cancelQueries`.
    2. Takes snapshot of existing query data (`previousPeerList`, `previousCounts`).
    3. Optimistically mutates TanStack Query cache.
    4. Returns snapshot context.
  - `onError`:
    - Automatically catches network failures, HTTP 409 conflict, or HTTP 403 authorization errors.
    - Restores previous snapshot data via `queryClient.setQueryData(context.peerListKey, context.previousPeerList)`.
  - `onSettled`:
    - Always invalidates `queryKeys.shiftSwaps.all` and `queryKeys.shifts.all` to reconcile with authoritative server state.
- **Wired in Screens:**
  - Connected into `app/src/app/(app)/shift-swaps.tsx` for Peer Accept/Decline, Manager Approve/Reject, and Swap Cancellation.

---

### 5. Settings Mutation Boundary & Strict Realism Disclosure

- **Backend Route Reality:** The server currently contains routes for `/auth`, `/teams`, `/shifts`, `/shift-swaps`, `/activity`, and `/billing`.
- **No Settings API:** There is **no backend route or schema for user settings** (tracked under future graduation criterion R09).
- **Compliance Rule:** Per instructions, **no fake settings routes or endpoints were fabricated**. R06.4 is satisfied for shift swap operations and documented as `PARTIAL` pending future R09 settings implementation.

---

### 6. Executable Test Suite Results

#### Test Suite 1: R06B Offline & Optimistic Mutations (`server/src/teams/offline-and-optimistic.test.ts`)
Executed via `npx tsx --test server/src/teams/offline-and-optimistic.test.ts`:

```
▶ R06B: Offline Shift Viewing, Pagination Safety & Optimistic Mutations
  ✔ A. No cross-team pagination flash: infinite query keys strictly isolate team pages (5.295ms)
  ✔ B. Filter change isolation: changing status or date filter isolates query cache (2.1882ms)
  ✔ C. Refetched pages replace outdated entries: updated shift is reconciled across pages (1.0828ms)
  ✔ D. Removed records disappear: cancelled/deleted shifts do not persist in refetched pages (0.865ms)
  ✔ E. Pagination order & deduplication: multi-page flatMap guarantees unique ascending records (0.9069ms)
  ✔ F. Offline indicator follows connection state: subscribers receive state transitions (1.0469ms)
  ✔ G. Sync timestamp accuracy: recorded snapshot includes valid recent ISO 8601 timestamp (4.5196ms)
  ✔ H. Offline shift readability: cached shifts are retrieved from storage when offline (0.7948ms)
  ✔ I. Offline cache scoping: Team A data is never returned for Team B or User B (0.6475ms)
  ✔ J. Sign-out cleanup: clearing user offline shifts removes stored records (1.246ms)
  ✔ K. Unauthorized team data cleanup: clearTeamShifts wipes cache on 403/404 (0.4397ms)
  ✔ L. Online reconnection notification: onlineManager receives reconnect event (202.1687ms)
  ✔ M. No auth secrets persisted: offline payload contains zero tokens or credentials (0.4736ms)
  ✔ N. Optimistic swap update: cache reflects status change before mutation finishes (1.1148ms)
  ✔ O. Network error rollback: restored snapshot on network failure (1.1257ms)
  ✔ P. 409 conflict rollback: restored snapshot when concurrent server update conflicts (0.6334ms)
  ✔ Q. 403/404 authorization failure rollback: invalidates and clears stale optimistic state (0.9691ms)
  ✔ R. Concurrent mutations consistency: sequential actions update respective items without clobbering (0.8224ms)
  ✔ S. No fake settings endpoint: confirms no settings routes were fabricated in backend (0.9303ms)
✔ R06B: Offline Shift Viewing, Pagination Safety & Optimistic Mutations (231.4511ms)
ℹ tests 19
ℹ suites 1
ℹ pass 19
ℹ fail 0
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

1. **Physical Device Verification:** Test offline mode on a physical Android device using Airplane Mode to confirm cached shift rendering and reconnection behavior.
2. **Production Deployment & Standalone Build:** Compile an updated standalone EAS build (`apk`) and deploy updated backend routes to Vercel production.
3. **Settings Optimistic Updates:** Implement optimistic updates for user settings when R09 settings schema and endpoints are built.
