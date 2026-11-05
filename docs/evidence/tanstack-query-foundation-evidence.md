# ROTA — TASK R06A EVIDENCE
## TanStack Query Foundation & Client State Architecture

**Repository:** `C:\Users\USER\rota-mobile`  
**Verified Baseline:** `9cc9ede7f9b6f1e4aefd58e9b5185a6839287fe9`  
**Requirements Addressed:** R06.1, R06.2, R06.5  
**Evaluation Dimensions:** Impl: YES | Test: YES | Dep: NO | Evid: YES  
**Status Result:** PARTIAL (Awaiting production deployment & standalone APK build)  

---

### 1. Installed Package & Compatibility

- **Package:** `@tanstack/react-query@5.106.1`
- **Host Platform & Toolchain:**
  - Expo SDK: `~57.0.28`
  - React: `19.2.3`
  - React Native: `0.86.3`
  - TypeScript: `~6.0.3`
  - Node.js runtime: `v24.16.0`
- **Dependency Invariant:** Zero extraneous packages installed. Synchronized in `app/package.json` and `app/package-lock.json`.

---

### 2. QueryClient Setup & Application Root Integration

- **Singleton Client & Factory:** Implemented in `app/src/services/query/queryClient.ts` (`queryClient`, `createQueryClient()`).
- **Application Root (`app/src/app/_layout.tsx`):**
  - `<QueryClientProvider client={queryClient}>` wraps `<AuthProvider>`, granting all nested Expo Router screens access to the query client.
  - Native foreground synchronization listener wired via `setupQueryFocusManager(AppState, Platform.OS !== 'web')`.
- **Session Cleanup (`app/src/context/AuthContext.tsx`):**
  - Sign-out (`signOut()`) and session invalidation (`clearCredentials()`) invoke `clearQueryCache(queryClient)`.
  - Prior to applying fresh credentials on `signIn()`, `signInWithMagicLink()`, and `register()`, `clearQueryCache(queryClient)` is executed to ensure zero session bleed.

---

### 3. Cache Policies & Invariants

| Configuration Key | Configured Value | Architectural Justification |
| :--- | :--- | :--- |
| `staleTime` | `120,000ms` (2 minutes) | Prevents redundant network requests when switching between dashboard tabs or navigating to modal overlays. |
| `gcTime` | `600,000ms` (10 minutes) | Retains inactive queries in memory for quick back-navigation while allowing garbage collection to reclaim memory. |
| `retry` | `shouldRetryQuery(failureCount, error)` | Up to 2 retries (total 3 attempts) for transient 5xx server or network errors. Fail-fast (`false`) on HTTP 401, 403, and 404 client errors. |
| `retryDelay` | `calculateRetryBackoff(attempt)` | Exponential backoff: `Math.min(1000 * 2 ** attempt, 30000)` ms (1s, 2s, 4s, 8s, up to 30s cap). |
| `refetchOnWindowFocus` | `true` | Integrated with React Native `AppState` to refresh stale data when returning from background. |
| `refetchOnReconnect` | `true` | Automatically triggers refetch of stale queries upon network recovery. |

---

### 4. Structured Hierarchical Query Key Factories

Implemented in `app/src/services/query/queryKeys.ts`:

- **Teams:**
  - `queryKeys.teams.all(userId)`: `['teams', userId]`
  - `queryKeys.teams.list(userId)`: `['teams', userId, 'list']`
  - `queryKeys.teams.detail(userId, teamId)`: `['teams', userId, 'detail', teamId]`
- **Members:**
  - `queryKeys.members.all(teamId, userId)`: `['members', teamId, userId]`
  - `queryKeys.members.list(teamId, userId, params)`: `['members', teamId, userId, 'list', params]`
  - `queryKeys.members.allList(teamId, userId)`: `['members', teamId, userId, 'allList']`
  - `queryKeys.members.invitations(teamId, userId)`: `['members', teamId, userId, 'invitations']`
- **Shifts:**
  - `queryKeys.shifts.all(teamId, userId)`: `['shifts', teamId, userId]`
  - `queryKeys.shifts.list(teamId, userId, params)`: `['shifts', teamId, userId, 'list', params]`
  - `queryKeys.shifts.detail(teamId, shiftId, userId)`: `['shifts', teamId, userId, 'detail', shiftId]`
- **Shift Swaps:**
  - `queryKeys.shiftSwaps.all(teamId, userId)`: `['shiftSwaps', teamId, userId]`
  - `queryKeys.shiftSwaps.list(teamId, userId, params)`: `['shiftSwaps', teamId, userId, 'list', params]`
  - `queryKeys.shiftSwaps.pendingCounts(teamId, userId)`: `['shiftSwaps', teamId, userId, 'pendingCounts']`
- **Activity Feed:**
  - `queryKeys.activity.all(teamId, userId)`: `['activity', teamId, userId]`
  - `queryKeys.activity.feed(teamId, userId, query)`: `['activity', teamId, userId, 'feed', query]`

---

### 5. Screens Migrated to TanStack Query

1. **Team Selection (`app/src/app/(app)/select-team.tsx`):**
   - Migrated manual `loadTeams` to `useTeams(user?.id)`.
   - Migrated team creation to `useCreateTeam(user?.id)` with targeted invalidation of `queryKeys.teams.all(user.id)`.
   - Integrated native pull-to-refresh with `refetch()`.
2. **Shift Dashboard (`app/src/app/(app)/index.tsx`):**
   - Migrated shift retrieval to `useShifts(selectedTeam?.id, user?.id, shiftParams)`.
   - Migrated member assignment list to `useTeamAllMembers(selectedTeam?.id, user?.id)`.
   - Migrated pending swap badge counts to `usePendingSwapsSummary(selectedTeam?.id, user?.id)`.
   - Migrated shift creation, update, and cancellation to `useCreateShift`, `useUpdateShift`, and `useCancelShift` with targeted cache invalidation.
   - Connected `useFocusEffect` to refresh schedule queries upon regaining navigation focus.
3. **Team Members (`app/src/app/(app)/members.tsx`):**
   - Migrated paginated members to `useTeamMembers(selectedTeam?.id, user?.id, page, 20)`.
   - Migrated owner invitation list to `useTeamInvitations(selectedTeam?.id, user?.id, isOwner)`.
   - Migrated mutations (`useAddMember`, `useUpdateMemberRole`, `useRemoveMember`, `useCreateInvitation`, `useRevokeInvitation`) with targeted invalidations.
   - Retained local UI states for clipboard copying, modals, busy member IDs, and form inputs.

---

### 6. State Architecture & Ownership Boundaries

- **Server State:** Handled exclusively by TanStack Query (`useQuery`, `useMutation`).
- **Auth State:** Handled by `AuthContext` (in-memory access tokens, refresh token rotation).
- **Persistent State:** Managed via `expo-secure-store` (`rota.refresh-token.*`, `rota.selected-team.*`, `rota.last-user-id`).
- **UI State:** Handled via component `useState` (modals, active filter drafts, form fields).
- **Sensitive Token Invariant:** No access tokens, refresh tokens, or invitation tokens are stored in the TanStack Query cache.

---

### 7. Executable Test Suite Evidence

Executed via `npx tsx --test server/src/teams/tanstack-query-foundation.test.ts`:

```
▶ R06A: TanStack Query Foundation & Client State Architecture
  ✔ A. Query key stability: produces consistent deterministic keys (6.9511ms)
  ✔ B. Team isolation: team A and team B queries are completely segregated in cache (4.0343ms)
  ✔ C. User/account isolation: user A and user B queries are strictly isolated (0.9128ms)
  ✔ D. Pagination keys: different page parameters produce distinct cache partitions (0.4352ms)
  ✔ E. Filter keys: status and date filters produce distinct query keys (0.6848ms)
  ✔ F. Same-query deduplication: concurrent identical queries invoke fetcher exactly once (33.5862ms)
  ✔ G. Targeted invalidation: mutating team A shifts invalidates only team A shift queries (3.5699ms)
  ✔ H. Cache clearing on sign-out: clearQueryCache wipes all cached queries and states (1.8378ms)
  ✔ I. Account switching: clearing cache prevents previous user records from appearing to new user (1.2008ms)
  ✔ J. Team switching: switching from team 1 to team 2 queries distinct keys without cross-contamination (1.3839ms)
  ✔ K. Foreground refetch behavior: focusManager activates on active AppState and deactivates on background (0.8758ms)
  ✔ L. Cache policy configuration: validates staleTime (2 min) and gcTime (10 min) (0.4313ms)
  ✔ M. Retry policy: exponential backoff and no-retry on 401/403/404 (0.5293ms)
  ✔ N. No sensitive-token persistence: query keys and data do not persist auth secrets or tokens (0.6705ms)
  ✔ O. Pagination behavior: multi-page queries accumulate properly without duplication (0.6184ms)
✔ R06A: TanStack Query Foundation & Client State Architecture (62.8846ms)
ℹ tests 15
ℹ suites 1
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1690.4643
```

- Mobile invitation regression test suite (`mobile-invitation-logic.test.ts`): **30 passed, 0 failed**.
- TypeScript typecheck (`app` and `server`): **0 errors**.

---

### 8. Remaining Work for R06B

1. **R06.3 — Offline Shift Viewing:**
   - Configure persistent offline storage adapter (`createAsyncStoragePersister` or SecureStore-backed SQLite cache).
   - Implement client-side synchronization timestamp and offline status indicator banner.
2. **R06.4 — Optimistic UI Updates:**
   - Implement `onMutate`, `onError` rollback, and `onSettled` cache reconciliation for shift swap requests and member updates.
3. **Physical Device & Production Verification:**
   - Compile EAS build and perform physical Android smoke-testing.
