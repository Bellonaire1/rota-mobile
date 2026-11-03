# ROTA — Shift Swap Workflow Autonomous End-to-End Test Evidence (R04.3 / R04.4)

> **Dev and Design HQ — Product Design and Engineering Bootcamp**  
> **Requirement IDs:** R04.3 (Peer Shift Swap Proposals) & R04.4 (Manager Review & Conflict Handling)  
> **Repository:** `C:\Users\USER\rota-mobile`  
> **Test Baseline:** `78c9619c077eecc08c6b81c5330ffc34afca7221` on branch `main`  
> **Execution Date:** November 3, 2026  
> **Execution Mode:** Autonomous QA Automation Runner (`server/src/e2e-shift-swap-runner.ts`)  
> **Target Status:** **PARTIAL** (Backend API, database state transitions, serializable concurrency control, and mobile integration code verified; physical device UI test remaining)

---

## 1. Test Environment & Database Safety Verification

All test scenarios were executed exclusively against the approved isolated disposable Neon PostgreSQL instance under strict fail-closed safety guard enforcement.

| Attribute | Verified Setting | Safety Invariant Proof |
| :--- | :--- | :--- |
| **Neon Project ID** | `calm-bird-93784411` | Approved disposable test project (`rota-auth-disposable`) |
| **Database Name** | `neondb` | Disposable database |
| **Endpoint Host** | `ep-small-dawn-za43lp0z.c-2.eu-west-2.aws.neon.tech` | Matches approved disposable endpoint regex |
| **Database Role** | `AUTH_TEST_DATABASE=disposable` | Validated by `authIntegrationSkipReason()` |
| **Safety Launcher** | `server/src/safe-test-launcher.ts` | Refuses connection to protected demo (`ep-falling-pine`) and persistent test (`ep-proud-shadow`) databases |
| **API Server Base URL**| `http://localhost:5000/api/v1` | Process-isolated Express server on port 5000 |
| **Secret Sanitization**| Zero credentials logged | Password hashes, JWT tokens, and connection strings strictly sanitized |

---

## 2. Test Execution Summary & Assertion Audit

| Metric | Count | Description |
| :--- | :---: | :--- |
| **Total Executable Assertions** | **22** | All 22 assertions executed and passed directly in `e2e-shift-swap-runner.ts` |
| **HTTP API Endpoint Tests** | **15** | Direct HTTP requests testing endpoints, roles, and status codes (201, 200, 400, 401, 403, 404, 409) |
| **Direct PostgreSQL State Tests** | **7** | Direct database queries asserting immutable shift assignments, status transitions, and audit records |
| **Reused Earlier Results** | **0** | No results were reused or imported from prior test runs |
| **Unexecuted Scenarios** | **0** | Zero descriptive or skipped scenarios |
| **Success Rate** | **100%** | 22 passed, 0 failed, 0 skipped |

---

## 3. End-to-End Workflow Test Results

### Test 1 — Staff Peer Swap Proposal
- **Actor:** Staff A (`staff.a@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps`
- **Payload:** Proposes exchange of Shift 1 (*Morning Support*, assigned to Staff A) with Shift 2 (*Evening Coverage*, assigned to Staff B).
- **HTTP Response:** `HTTP 201 Created`
- **Resulting Status:** `PENDING_PEER`
- **Database Assignment Verification:** Both shift assignments remain untouched in PostgreSQL:
  - Shift 1 assigned to Staff A (`staff.a@example.com`)
  - Shift 2 assigned to Staff B (`staff.b@example.com`)
- **Status:** **PASS**

### Test 2 — Peer Acceptance
- **Actor:** Staff B (`staff.b@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps/:swapId/respond`
- **Payload:** `{ "action": "accept" }`
- **HTTP Response:** `HTTP 200 OK`
- **Resulting Status:** `PENDING_MANAGER`
- **Audit Field:** `peerRespondedAt` recorded with timestamp.
- **Database Assignment Verification:** Shift assignments remain unchanged while awaiting manager approval.
- **Status:** **PASS**

### Test 3 — Manager Approval & Atomic Shift Exchange
- **Actor:** Owner/Manager (`owner.manager@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps/:swapId/review`
- **Payload:** `{ "action": "approve" }`
- **HTTP Response:** `HTTP 200 OK`
- **Resulting Status:** `APPROVED`
- **Audit Fields:** `reviewedByUserId` recorded as Owner ID; `reviewedAt` recorded with timestamp.
- **PostgreSQL Direct Query Verification:**
  - Shift 1 (*Morning Support*): Reassigned atomically to Staff B (`staff.b@example.com`).
  - Shift 2 (*Evening Coverage*): Reassigned atomically to Staff A (`staff.a@example.com`).
  - Both shifts updated within a single interactive database transaction.
- **Status:** **PASS**

### Test 4 — Peer Decline Workflow
- **Actor:** Staff B (`staff.b@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps/:swapId/respond`
- **Payload:** `{ "action": "decline" }`
- **HTTP Response:** `HTTP 200 OK`
- **Resulting Status:** `DECLINED`
- **Database Assignment Verification:** Both shifts remain with original assignees.
- **Status:** **PASS**

### Test 5 — Manager Rejection Workflow
- **Actor:** Owner/Manager (`owner.manager@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps/:swapId/review`
- **Payload:** `{ "action": "reject", "reason": "Test rejection" }`
  *(Note: The API contract accepts `reason`, which is mapped to the Prisma schema field `rejectionReason`)*
- **HTTP Response:** `HTTP 200 OK`
- **Resulting Status:** `REJECTED`
- **Database Persistence Assertions:**
  - `rejectionReason`: Persisted as `"Test rejection"` in PostgreSQL.
  - `reviewedByUserId`: Persisted with manager's user ID.
  - `reviewedAt`: Persisted with valid review timestamp.
  - Both shift assignments: Remain unchanged with original assignees.
- **Supported List Query Verification:**
  - `GET /api/v1/teams/:teamId/shift-swaps?status=REJECTED` confirms the swap request is listed with status `REJECTED` and `rejectionReason: "Test rejection"`.
- **Status:** **PASS**

### Test 6 — Requester Cancellation Workflow
- **Actor:** Staff A (`staff.a@example.com`)
- **Action:** `POST /api/v1/teams/:teamId/shift-swaps/:swapId/cancel`
- **HTTP Response:** `HTTP 200 OK`
- **Resulting Status:** `CANCELLED`
- **Database Assignment Verification:** Both shifts remain with original assignees.
- **Status:** **PASS**

---

## 4. Security, Invariant & Concurrency Verification

| Test ID | Scenario | Expected Status | Actual Status | Database State / Invariant Result | Verdict |
| :--- | :--- | :---: | :---: | :--- | :---: |
| **7A** | Unauthenticated request (no JWT bearer token) | `HTTP 401` | `HTTP 401 Unauthorized` | Zero mutations permitted; generic error returned | **PASS** |
| **7B** | Staff role attempts manager review (`POST /review`) | `HTTP 403` | `HTTP 403 Forbidden` | RBAC guard blocks non-manager; zero state change | **PASS** |
| **7C** | Mutation against non-member foreign team ID | `HTTP 404` | `HTTP 404 Not Found` | Tenant isolation guard prevents IDOR / enumeration | **PASS** |
| **7D** | Premature manager approval (in `PENDING_PEER` status) | `HTTP 409` | `HTTP 409 Conflict` | Manager cannot bypass peer consent | **PASS** |
| **7E** | Duplicate active swap request on an already involved shift | `HTTP 409` | `HTTP 409 Conflict` | Shift locked from concurrent duplicate proposals | **PASS** |
| **7F-1**| Proposal creation referencing a cancelled shift | `HTTP 400` | `HTTP 400 Bad Request` | Proposal rejected: both shifts must be scheduled | **PASS** |
| **7F-2**| Approval of swap where shift was cancelled post-proposal | `HTTP 409` | `HTTP 409 Conflict` | Approval rejected: cancelled shifts cannot swap | **PASS** |
| **7G** | Overlapping schedule conflict detected at approval | `HTTP 409` | `HTTP 409 Conflict` | Schedule conflict guard prevents double-booking | **PASS** |
| **7H-1**| Concurrent competing creation requests (race condition) | Exactly 1 `201`, 1 `409` | 1 `HTTP 201`, 1 `HTTP 409` | Handled via transaction locking; exactly 1 accepted | **PASS** |
| **7H-2**| PostgreSQL state verification after concurrent race | Exactly 1 record | Exactly 1 active swap | Database consistency preserved; zero duplicates | **PASS** |

---

## 5. Shift Assignment Verification (PostgreSQL Direct Snapshots)

### Pre-Swap Baseline State
```
Shift ID                             Title             Assigned To   User Email
------------------------------------ ----------------- ------------- ---------------------
5a109867-0dfa-45c5-bc95-045353000001 Morning Support   Staff A       staff.a@example.com
5a109867-0dfa-45c5-bc95-045353000002 Evening Coverage  Staff B       staff.b@example.com
```

### Post-Approval Executed State
```
Shift ID                             Title             Assigned To   User Email
------------------------------------ ----------------- ------------- ---------------------
5a109867-0dfa-45c5-bc95-045353000001 Morning Support   Staff B       staff.b@example.com
5a109867-0dfa-45c5-bc95-045353000002 Evening Coverage  Staff A       staff.a@example.com

Audit Metadata:
  Status:           APPROVED
  Reviewed By:      14b82f81-eb2d-47f9-802b-e40f98a30f6a (owner.manager@example.com)
  Reviewed At:      2026-11-03T20:37:00.000Z
  Rejection Reason: null
```

---

## 6. Exercised API Endpoint Inventory

| HTTP Method | Full Path | Purpose | Required Role | Actual Test Result |
| :--- | :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/auth/login` | Authenticate synthetic user sessions | Public | `HTTP 200 OK` |
| `POST` | `/api/v1/teams/:teamId/shift-swaps` | Propose two-way peer shift swap | `STAFF` | `HTTP 201 Created` / `HTTP 400` / `HTTP 401` / `HTTP 409` |
| `GET` | `/api/v1/teams/:teamId/shift-swaps` | Query team shift swaps with status filter (`?status=...`) | `STAFF` / `MANAGER` / `OWNER` | `HTTP 200 OK` |
| `POST` | `/api/v1/teams/:teamId/shift-swaps/:swapId/respond` | Peer response (`accept` or `decline`) | `STAFF` (Target Peer) | `HTTP 200 OK` |
| `POST` | `/api/v1/teams/:teamId/shift-swaps/:swapId/review` | Manager review (`approve` or `reject` with reason) | `MANAGER` / `OWNER` | `HTTP 200 OK` / `HTTP 403` / `HTTP 404` / `HTTP 409` |
| `POST` | `/api/v1/teams/:teamId/shift-swaps/:swapId/cancel` | Cancel unresolved swap proposal | `STAFF` (Requester) | `HTTP 200 OK` |
| `GET` | `/api/v1/teams/:teamId/shifts` | Query team shifts for assignment checks | `STAFF` / `MANAGER` / `OWNER` | `HTTP 200 OK` |

*(Note: Prior draft erroneously listed `GET /api/v1/teams/:teamId/shift-swaps/:swapId`. That endpoint does not exist; individual swap state is queried via the supported list endpoint `GET /api/v1/teams/:teamId/shift-swaps` or verified directly in PostgreSQL).*

---

## 7. Mobile UI Automation Feasibility Assessment

> [!WARNING]
> **Android UI NOT VERIFIED (`EMULATOR_UNAVAILABLE`)**  
> Physical device and native emulator testing has **NOT** been performed.

- **Host Environment:** Windows 11 Enterprise (local machine).
- **Tool Assessment:** Checked ADB (`adb`), Android Emulator (`emulator`), and Android SDK environment variables (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, `AppData\Local\Android\Sdk`). None are installed on this workstation.
- **Scope Compliance:** Heavy software downloads (>5 GB) were not installed without user approval. API verification is strictly separated from native UI testing.
- **Code Health:** Mobile application client source code (`swap-request.tsx`, `shift-swaps.tsx`, `shiftSwapService.ts`, `index.tsx`, `AuthContext.tsx`) compiles cleanly with zero TypeScript errors (`tsc --noEmit`). Expo Metro server is operating in LAN mode (`exp://192.168.1.4:8081`).
- **Recommended Smoke Test:** A concise visual smoke check on a physical device using Expo Go when convenient for the user.

---

## 8. Compliance Tracker Recommendation

In accordance with strict graduation audit rules, **R04.3 and R04.4 remain PARTIAL** until physical device verification or emulator execution is performed.

- **R04.3 Status:** **PARTIAL** (Backend API, database models, validation, and mobile UI implementation complete; physical device execution remaining).
- **R04.4 Status:** **PARTIAL** (Manager review API, conflict detection, atomic shift swap transaction, and mobile review UI complete; physical device execution remaining).
