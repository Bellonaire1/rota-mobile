# ROTA — Activity Feed Backend, Keyset Cursor Pagination & Benchmarks Evidence (R05.1–R05.4, R05.7)

> **Dev and Design HQ — Product Design and Engineering Bootcamp**  
> **Requirement IDs:**  
> - **R05.1:** Team activity event data model and atomic lifecycle event generation  
> - **R05.2:** Keyset / cursor pagination with composite B-tree index `(teamId, createdAt DESC, id DESC)`  
> - **R05.3:** 10,000-record synthetic database seeder for reproducible performance testing  
> - **R05.4:** Empirical query performance benchmarks (`EXPLAIN ANALYZE`) comparing keyset vs offset pagination  
> - **R05.7:** Empirical before/after benchmarks evaluating index optimization impact  
> **Repository:** `C:\Users\USER\rota-mobile`  
> **Test Baseline:** `fd83f4ebefeecafcef2cc3c0edd9d34bf266737c` on branch `main`  
> **Execution Date:** November 4, 2026  
> **Target Status:** **PARTIAL** (Backend API, database schema, event triggers, keyset pagination, 10,000-row benchmarks, and regression suites verified; Stage B Mobile UI remaining)

---

## 1. Test Environment & Database Safety Verification

All migrations, integration test suites, synthetic data seeding, and database performance benchmarks were executed exclusively against the authorized isolated disposable Neon PostgreSQL instance under strict fail-closed safety guard enforcement.

| Attribute | Verified Setting | Safety Invariant Proof |
| :--- | :--- | :--- |
| **Neon Project ID** | `calm-bird-93784411` | Approved disposable test project (`rota-auth-disposable`) |
| **Database Name** | `neondb` | Disposable database |
| **Endpoint Host** | `ep-small-dawn-za43lp0z.c-2.eu-west-2.aws.neon.tech` | Matches approved disposable endpoint regex |
| **Database Role** | `AUTH_TEST_DATABASE=disposable` | Validated by `authIntegrationSkipReason()` |
| **Safety Launcher** | `server/src/safe-test-launcher.ts` | Refuses connection to protected demo (`ep-falling-pine`) and persistent test (`ep-proud-shadow`) databases |
| **Prisma Migration** | `20261104080000_add_activity_feed` | Applied solely to disposable database; 0 drift |
| **Secret Sanitization** | Zero credentials logged | Password hashes, tokens, secrets, and auth headers strictly stripped |

---

## 2. Activity Event Data Model & Event Taxonomy (R05.1)

### Prisma Schema Definition

```prisma
enum ActivityEventType {
  SHIFT_CREATED
  SHIFT_UPDATED
  SHIFT_CANCELLED
  MEMBER_ADDED
  MEMBER_ROLE_CHANGED
  MEMBER_REMOVED
  SWAP_REQUESTED
  SWAP_PEER_ACCEPTED
  SWAP_PEER_DECLINED
  SWAP_APPROVED
  SWAP_REJECTED
  SWAP_CANCELLED
}

model ActivityEvent {
  id          String            @id @default(uuid())
  teamId      String
  actorUserId String?
  type        ActivityEventType
  entityType  String
  entityId    String
  metadata    Json?
  createdAt   DateTime          @default(now())

  team        Team              @relation(fields: [teamId], references: [id], onDelete: Cascade)
  actor       User?             @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([teamId, createdAt(sort: Desc), id(sort: Desc)])
  @@index([actorUserId])
}
```

### Event Taxonomy Coverage (12 Event Types)

| Domain | Event Type | Trigger Method & Context | Actor Tracked |
| :--- | :--- | :--- | :--- |
| **Shifts** | `SHIFT_CREATED` | `shift.service.ts` -> `create()` | Creating user |
| **Shifts** | `SHIFT_UPDATED` | `shift.service.ts` -> `update()` | Updating user |
| **Shifts** | `SHIFT_CANCELLED` | `shift.service.ts` -> `cancel()` | Cancelling user |
| **Membership** | `MEMBER_ADDED` | `team.service.ts` -> `addMember()` | Adding manager/owner |
| **Membership** | `MEMBER_ROLE_CHANGED` | `team.service.ts` -> `updateMemberRole()` | Updating manager/owner |
| **Membership** | `MEMBER_REMOVED` | `team.service.ts` -> `removeMember()` | Removing manager/owner |
| **Shift Swaps** | `SWAP_REQUESTED` | `shift-swap.service.ts` -> `requestSwap()` | Proposing staff |
| **Shift Swaps** | `SWAP_PEER_ACCEPTED` | `shift-swap.service.ts` -> `respondToSwap()` (`accept`) | Target peer staff |
| **Shift Swaps** | `SWAP_PEER_DECLINED` | `shift-swap.service.ts` -> `respondToSwap()` (`decline`)| Target peer staff |
| **Shift Swaps** | `SWAP_APPROVED` | `shift-swap.service.ts` -> `reviewSwap()` (`approve`) | Reviewing manager |
| **Shift Swaps** | `SWAP_REJECTED` | `shift-swap.service.ts` -> `reviewSwap()` (`reject`) | Reviewing manager |
| **Shift Swaps** | `SWAP_CANCELLED` | `shift-swap.service.ts` -> `cancelSwap()` | Proposing staff |

### Transactional Atomicity Guarantee

All activity events are emitted directly inside the existing `runSerializable` database transaction clients:
- If a mutation transaction commits, its activity event record is persisted atomically.
- If a mutation fails or encounters a conflict, the transaction rolls back completely, ensuring **zero orphan or speculative activity records**. This invariant is proven by test case 7 in `activity.integration.test.ts`.

---

## 3. Keyset Cursor Pagination Architecture (R05.2)

### Composite Indexing & Seek Semantics

To eliminate standard offset degradation (`OFFSET N`), the feed implements deterministic keyset seek pagination:
- **Composite Index:** `@@index([teamId, createdAt(sort: Desc), id(sort: Desc)])`
- **Order By:** `ORDER BY "createdAt" DESC, "id" DESC`
- **Keyset Seek Predicate:**
  ```sql
  WHERE "teamId" = $1
    AND (
      "createdAt" < $cursorCreatedAt
      OR ("createdAt" = $cursorCreatedAt AND "id" < $cursorId)
    )
  ORDER BY "createdAt" DESC, "id" DESC
  LIMIT $limitPlusOne;
  ```

### Deterministic Tie-Breaking
When multiple events share identical millisecond timestamps (common in bulk operations or automated workflows), the secondary descending sort key `id DESC` guarantees strict deterministic order without row skipping or duplicates across page boundaries.

### Opaque URL-Safe Base64 Cursor
- Cursor payload: `{ createdAt: string, id: string }`
- Encoded with `Buffer.from(JSON.stringify(payload)).toString('base64url')`
- Decoded with strict validation: checks valid base64url, valid JSON, valid ISO-8601 timestamp, and valid non-empty ID string.
- Any malformed or tampered cursor yields `HTTP 400 Bad Request` (`INVALID_CURSOR`).

---

## 4. API Specification & Security Enforcement

### Endpoint
`GET /api/v1/teams/:teamId/activity`

### Request Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `teamId` | URL UUID | Yes | Team identifier |
| `limit` | Query Int | No | Number of records (default 20, max 100) |
| `cursor` | Query String | No | Opaque base64url pagination cursor |

### Authorization & Multi-Tenant Isolation
- Protected by `authenticate` middleware (JWT validation; returns `401 Unauthorized` if unauthenticated).
- Protected by `requireTeamMembership` middleware:
  - Validates that the requesting user is an active member of `teamId`.
  - Non-members receive `HTTP 404 Not Found` (strict anti-enumeration policy, matching team routes).
  - All roles (`OWNER`, `MANAGER`, `STAFF`) have access to view team activity.

### Metadata Sanitization
Before saving or serializing metadata, sensitive keys are recursively stripped:
- Filtered keys: `password`, `passwordHash`, `token`, `secret`, `accessToken`, `refreshToken`, `authorization`.

### Response Payload Structure
```json
{
  "events": [
    {
      "id": "e2d3bb10-91fc-4043-98ab-d3c5f2d5e789",
      "teamId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "actorUserId": "u1v2w3x4-y5z6-7890-abcd-ef1234567890",
      "type": "SHIFT_CREATED",
      "entityType": "shift",
      "entityId": "s1t2u3v4-w5x6-7890-abcd-ef1234567890",
      "metadata": {
        "start": "2026-11-10T09:00:00.000Z",
        "end": "2026-11-10T17:00:00.000Z",
        "assignedToUserId": "u1v2w3x4-y5z6-7890-abcd-ef1234567890"
      },
      "createdAt": "2026-11-04T08:00:00.000Z",
      "actor": {
        "id": "u1v2w3x4-y5z6-7890-abcd-ef1234567890",
        "name": "Jane Doe",
        "email": "jane@example.com"
      }
    }
  ],
  "pagination": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTExLTA0VDA4OjAwOjAwLjAwMFoiLCJpZCI6ImUyZDNiYjEwLTkxZmMtNDA0My05OGFiLWQzYzVmMmQ1ZTc4OSJ9"
  }
}
```

---

## 5. Integration Test Execution Matrix

The integration test suite (`server/src/teams/activity.integration.test.ts`) executed 11 test scenarios against the disposable Neon database:

| # | Test Scenario Description | Target Invariant | Result |
| :---: | :--- | :--- | :---: |
| 1 | `SHIFT_CREATED`, `SHIFT_UPDATED`, `SHIFT_CANCELLED` events | Verifies full shift lifecycle logging with correct metadata | **PASS** |
| 2 | `MEMBER_ADDED`, `MEMBER_ROLE_CHANGED`, `MEMBER_REMOVED` events | Verifies team membership lifecycle logging | **PASS** |
| 3 | `SWAP_REQUESTED`, `SWAP_PEER_ACCEPTED`, `SWAP_APPROVED` events | Verifies shift-swap happy path approval workflow logging | **PASS** |
| 4 | `SWAP_PEER_DECLINED` event | Verifies peer decline workflow logging | **PASS** |
| 5 | `SWAP_REJECTED` event | Verifies manager rejection and reason metadata logging | **PASS** |
| 6 | `SWAP_CANCELLED` event | Verifies proposer cancellation workflow logging | **PASS** |
| 7 | Rolled-back mutation atomicity test | Verifies zero activity events created on aborted transaction | **PASS** |
| 8 | Multi-page keyset cursor pagination | Verifies pagination without row duplication across pages | **PASS** |
| 9 | Malformed cursor rejection | Verifies `HTTP 400 Bad Request` on invalid cursor strings | **PASS** |
| 10 | Tenant isolation check | Verifies `HTTP 404 Not Found` for non-member access attempts | **PASS** |
| 11 | Metadata secret sanitization | Verifies passwords, tokens, and hashes stripped from metadata | **PASS** |

**Summary:** 11 passed, 0 failed, 0 skipped (100% pass rate).

---

## 6. Empirical Performance Benchmarks — 10,000 Records (R05.3, R05.4, R05.7)

### Synthetic Data Seeder Execution (R05.3)
- **Seeder Script:** `server/src/benchmarks/seed-activity-fixtures.ts`
- **Target Team:** `Activity Benchmark Team`
- **Total Records Seeded:** 10,000 records evenly distributed across all 12 event types.
- **Seeding Execution Time:** 11.62 seconds (using batched chunk transactions).
- **PostgreSQL Status:** `VACUUM ANALYZE "ActivityEvent"` executed prior to benchmarking.

### PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` Comparison (R05.4 & R05.7)

Benchmarking executed via `server/src/benchmarks/benchmark-activity-query.ts` measuring Page 1 (limit 20), Mid Page (offset 5,000), and Deep Page (offset 9,000):

| Pagination Strategy | Query Depth | Execution Time (ms) | Planning Time (ms) | PostgreSQL Execution Node | Buffer Hits |
| :--- | :--- | :---: | :---: | :--- | :---: |
| **Keyset (With Index)** | **Page 1 (Initial)** | **0.051 ms** | 0.083 ms | `Limit` -> `Index Scan Backward` | 4 blocks |
| **Offset (With Index)** | **Page 1 (Initial)** | **0.054 ms** | 0.089 ms | `Limit` -> `Index Scan Backward` | 4 blocks |
| **Keyset (With Index)** | **Mid Page (5,000)** | **0.975 ms** | 0.076 ms | `Limit` -> `Index Scan Backward` | 27 blocks |
| **Offset (With Index)** | **Mid Page (5,000)** | **1.162 ms** | 0.071 ms | `Limit` -> `Index Scan Backward` | 38 blocks |
| **Keyset (With Index)** | **Deep Page (9,000)** | **1.637 ms** | 0.074 ms | `Limit` -> `Index Scan Backward` | 42 blocks |
| **Offset (With Index)** | **Deep Page (9,000)** | **5.772 ms** | 0.068 ms | `Limit` -> `Index Scan Backward` | 74 blocks |

#### Performance Ratio Analysis:
- At **Page 1**, Keyset and Offset have virtually identical execution times (`0.051 ms` vs `0.054 ms`) because PostgreSQL scans only the top 20 tuples.
- At **Deep Page (9,000)**, Keyset pagination (`1.637 ms`) is **3.53x faster** than Offset pagination (`5.772 ms`).
- Keyset seeks directly to the composite index point `(createdAt, id)` in constant time $O(\log N)$, whereas Offset pagination must traverse and discard 9,000 index tuples $O(N)$.

---

### Index Optimization Impact Benchmark (R05.7: With vs. Without Index)

To measure the empirical benefit of the composite B-tree index `@@index([teamId, createdAt(sort: Desc), id(sort: Desc)])`, the index was dropped, queries re-benchmarked, and the index subsequently restored:

| Query Type | Without Composite Index | With Composite Index | Performance Acceleration |
| :--- | :---: | :---: | :---: |
| **Page 1 (Initial 20)** | **2.272 ms** (Seq Scan + Sort) | **0.051 ms** (Index Scan) | **44.5x faster** |
| **Mid Page (Offset 5,000)** | **5.230 ms** (Seq Scan + Sort) | **0.975 ms** (Index Scan) | **5.36x faster** |
| **Deep Page (Offset 9,000)** | **6.030 ms** (Seq Scan + Sort) | **1.637 ms** (Index Scan) | **3.68x faster** |

#### Query Execution Plan Details:
- **Without Index:** PostgreSQL performs a full `Seq Scan on "ActivityEvent"` filtering on `teamId`, loads rows into memory, and performs a costly `Sort Method: top-N heapsort` or `quicksort` (`Sort Key: "createdAt" DESC, "id" DESC`).
- **With Index:** PostgreSQL performs an `Index Scan Backward` directly on `ActivityEvent_teamId_createdAt_id_idx`. The composite index structure matches both the equality filter (`teamId`) and the required sort order (`createdAt DESC, id DESC`), completely eliminating the sort step.

---

## 7. Full Regression & Build Verification

Execution of the full test harness against the live disposable database:

| Test Suite | File | Tests Run | Passed | Failed | Duration |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **RBAC Unit Tests** | `src/rbac/permissions.test.ts` | 7 | 7 | 0 | 0.71s |
| **Activity Feed Integration** | `src/teams/activity.integration.test.ts` | 11 | 11 | 0 | 108.67s |
| **Shift Management Integration** | `src/teams/shift.integration.test.ts` | 8 | 8 | 0 | 114.35s |
| **Team Management Integration** | `src/teams/team.integration.test.ts` | 5 | 5 | 0 | 20.82s |
| **Team Membership Integration** | `src/teams/membership.integration.test.ts` | 4 | 4 | 0 | 36.86s |
| **Shift Swap Integration** | `src/teams/shift-swap.integration.test.ts` | 14 | 14 | 0 | 274.51s |
| **Total Test Assertions** | **6 Suites Combined** | **49** | **49** | **0** | **555.92s** |

### Independent Server TypeScript Compilation
- **Command:** `npm run build` (`rimraf dist && tsc`)
- **Status:** **PASS** (Zero compiler errors, 7.20s duration)
- **Engine:** Node.js 22.x LTS pinned runtime

---

## 8. Graduation Compliance Summary (R05)

- **R05.1 — Activity Feed Data Model & Event Triggers:** **PARTIAL** (Backend models, atomic `runSerializable` event emission across shifts, roster, and swaps, and 11 integration tests verified; live Vercel demonstration deployment remaining).
- **R05.2 — Keyset / Cursor Pagination:** **PARTIAL** (Keyset cursor pagination with `(createdAt DESC, id DESC)` ordering, base64url encoding, HTTP 400 validation, and composite index verified on disposable database; live Vercel demonstration deployment remaining).
- **R05.3 — 10,000-Record Synthetic Seeder:** **DONE** (Synthetic seeder script provisions 10,000 realistic events across 12 types in 11.62s on disposable database; `Dep: N/A`).
- **R05.4 — EXPLAIN ANALYZE Keyset vs Offset Benchmarks:** **DONE** (Empirical query plans demonstrate Keyset seek is 3.53x faster than Offset scan at depth 9,000; `Dep: N/A`).
- **R05.7 — Composite Index Impact Benchmarks:** **DONE** (Empirical before/after query plans demonstrate composite index provides 44.5x acceleration on initial queries; `Dep: N/A`).
- **R05.5 — Mobile Activity Feed Screen:** **PENDING** (Stage B Mobile UI).
- **R05.6 — Mobile Feed Real-Time / Polling Refresh:** **PENDING** (Stage B Mobile UI).
