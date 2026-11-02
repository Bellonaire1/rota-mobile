# Rota — Final Graduation Submission Evidence

> **Dev and Design HQ — Product Design and Engineering Bootcamp**<br>
> **Final Graduation Task Evaluation Document**<br>
> **Project:** Rota (Team Shift-Scheduling Mobile Application)<br>
> **Evaluation Date:** November 2026<br>
> **Document Status:** Working Tree Draft (Pending Student Video & Reflections)

---

## 1. Verified Evidence Links

The following links represent live, verified deployment and build artifacts:

| Resource | Evidence Link | Verification Status | Notes |
| :--- | :--- | :---: | :--- |
| **GitHub Repository** | [https://github.com/Bellonaire1/rota-mobile](https://github.com/Bellonaire1/rota-mobile) | **VERIFIED** | Public source code repository containing mobile app, backend service, and technical documentation. |
| **Android APK Build** | [EAS Build Artifact](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8) | **VERIFIED** | Standalone internal preview APK (`Build ID 222cb397-2fdb-4286-9b49-009c59a470a8`). Successfully compiled on EAS cloud, downloaded, installed on physical Android hardware, and tested. |
| **Live Backend API** | [https://rota-api-demo.vercel.app/api/v1/health](https://rota-api-demo.vercel.app/api/v1/health) | **VERIFIED** | Live Vercel serverless deployment connected to Neon PostgreSQL. Responds with HTTP 200 `{ status: "ok" }`. *(Note: Validates Express process uptime; does not query Neon).* |

---

## 2. Completed & User-Tested Functionality

The following features have been implemented in code and confirmed:

### A. Mobile Application (`/app`)
- [x] **Cross-Platform Expo Router Navigation:** File-based navigation structure separating unauthenticated `(auth)` screens from authenticated `(app)` screens.
- [x] **User Authentication Screens:**
  - Login screen ([app/src/app/(auth)/login.tsx](../app/src/app/(auth)/login.tsx)) with email and password fields.
  - Registration screen ([app/src/app/(auth)/register.tsx](../app/src/app/(auth)/register.tsx)) with full name, email, and password (minimum 8 characters).
- [x] **Accessible Password Visibility Toggle:**
  - Integrated into `FormField` on both Login and Register screens.
  - Password hidden by default (`secureTextEntry=true`).
  - Zero-dependency custom vector `EyeIcon` rendered using pure React Native `View`s.
  - Exceeds minimum 44×44 touch target requirements (48×48 dimensions with `hitSlop`).
  - Descriptive accessibility labels and state hints (`accessibilityLabel`, `accessibilityHint`).
  - Suppresses auto-capitalization and auto-correction when revealed.
- [x] **Multi-Tenant Team Selection & Creation:**
  - Team selector screen ([app/src/app/(app)/select-team.tsx](../app/src/app/(app)/select-team.tsx)) listing user's memberships.
  - In-app team creation flow automatically designating creator as `OWNER`.
- [x] **Team Shift Operations Dashboard:**
  - Live operational dashboard ([app/src/app/(app)/index.tsx](../app/src/app/(app)/index.tsx)) displaying shifts for the selected team.
  - Shift scheduling modal for Managers and Owners.
  - Real-time date filtering (`YYYY-MM-DD`).
  - Shift editing and status modification.
  - Shift cancellation with actor/timestamp audit metadata (`cancelledByUserId`, `cancelledAt`) and optimistic concurrency check (`updatedAt`). *(No cancellation reason field in schema)*.
- [x] **Team Member Management Screen:**
  - Member roster screen ([app/src/app/(app)/members.tsx](../app/src/app/(app)/members.tsx)) displaying roles (`OWNER`, `MANAGER`, `STAFF`).
  - Add team member by registered User ID (`OWNER` only via `MANAGE_TEAM`).
  - Role promotion/demotion for members (`OWNER` only via `MANAGE_TEAM`).
  - Member removal with confirmation dialog (`OWNER` only via `MANAGE_TEAM`).
- [x] **Hardware-Backed Session Persistence:**
  - `expo-secure-store` stores opaque refresh token and active team ID across device restarts.
  - Automatic in-flight token refresh on HTTP 401 with transparent request replaying.
- [x] **Physical Android Device User Testing:**
  - Standalone APK downloaded and installed on physical Android hardware.
  - Authenticated into live Vercel backend.
  - Loaded active team dashboard from Neon PostgreSQL.
  - Updated a shift live from the installed app.

### B. Backend Service & Database (`/server`)
- [x] **Vercel Serverless Function Deployment:**
  - Zero-config Express preset utilizing `server/src/app.ts` as entrypoint.
  - Pinned Node.js 22.x engine (`package.json#engines.node`).
  - `server/package-lock.json` fully synchronized with production dependencies.
- [x] **Relational PostgreSQL Data Model:**
  - 15 relational tables defined in `server/prisma/schema.prisma`.
  - Prisma Client 6.4.1 compiled with `native` and `rhel-openssl-3.0.x` binaries.
  - Foreign key cascades and restrict rules preventing orphan records.
- [x] **Token Family Authentication:**
  - 15-minute access JWTs signed with minimum 32-character `JWT_ACCESS_SECRET`.
  - 30-day opaque refresh tokens hashed with SHA-256 in PostgreSQL.
  - Token reuse detection revoking the entire `familyId` on replay attempts.
  - Endpoints: Register, Login, Refresh, Logout, Logout-All, Me.
- [x] **Role-Based Access Control (RBAC):**
  - Centralized permission matrix (`server/src/rbac/permissions.ts`):
    - `OWNER`: All permissions including `MANAGE_TEAM` (add/remove members, role changes, billing, checkout).
    - `MANAGER`: `MANAGE_OPERATIONAL_WORK` (create/update/cancel shifts) and `MANAGE_STAFF`, but **NOT** `MANAGE_TEAM`.
    - `STAFF`: `VIEW_OPERATIONAL_WORK` (view shifts and member rosters).
  - Multi-tier middleware defense: `authenticate` $\to$ `requireTeamMembership` (404 for non-members) $\to$ `requireTeamPermission` (403 for unauthorized roles).
  - `GET /api/v1/teams/:id` requires authentication and performs a membership-scoped lookup in `teamService.getForUser()`.
  - `DEMO_MODE=true` blocks billing checkout with HTTP 403 regardless of user role.

---

## 3. Tested Functionality

### A. Automated Unit Test Execution (52 Passing Tests across 4 Suites)
Automated test suite executed in `server/`:

```bash
cd server && npx tsx --test src/billing/demo-mode.test.ts src/rbac/permissions.test.ts src/billing/pricing.test.ts src/billing/billing-calendar.test.ts
```

**Results:**
- **`billing-calendar.test.ts` (19 tests):** Validates month-end clamping policies, anniversary anchoring, leap year transitions (February 29), UTC instant preservation, and contiguous billing boundaries.
- **`demo-mode.test.ts` (2 tests):** Proves that `DEMO_MODE=true` immediately blocks Paystack checkout (`POST /api/v1/teams/:teamId/billing/checkout`) and Paystack webhook ingestion (`POST /api/v1/billing/webhooks/paystack`) with HTTP 403 Forbidden.
- **`pricing.test.ts` (24 tests):** Validates Starter, Team, and Business base prices, extra seat charges, staff exclusion math, and 20-of-30-day proration formulas.
- **`permissions.test.ts` (7 tests):** Validates OWNER, MANAGER, and STAFF permission grants and rejections across operational and team management boundaries.

**Summary:** `tests 52 | suites 14 | pass 52 | fail 0 | cancelled 0 | skipped 0`

> [!WARNING]
> **Integration Coverage Reality:**<br>
> These 52 passing tests validate offline mathematical, security, and schema boundaries only.<br>
> **All 10 database integration test suites** (`auth.integration.test.ts`, `team.integration.test.ts`, `membership.integration.test.ts`, `shift.integration.test.ts`, `billing.integration.test.ts`, `webhook-worker.integration.test.ts`, `webhook-reconciliation.integration.test.ts`, `subscription-entitlement.integration.test.ts`, `paystack-reconciliation.integration.test.ts`, `provider-plan-reservation.integration.test.ts`) were skipped during the reported test execution to adhere to non-destructive testing constraints. The reported 52-test unit run did not execute them, and no claim is made that they passed or failed. They require execution against an isolated database to prove full end-to-end integration.

### B. Static Type Checking & Code Quality
- **Backend Typecheck:** `npm --prefix server run typecheck` $\to$ **PASS** (0 errors).
- **Backend Build:** `npm --prefix server run build` $\to$ **PASS** (`rimraf dist && tsc` completed with exit code 0).
- **Mobile Typecheck:** `cd app && npx tsc --noEmit` $\to$ **PASS** (0 errors).
- **Prisma Schema Validation:** `npm --prefix server run prisma:validate` $\to$ **PASS** (Schema valid).
- **Lockfile Clean Install Check:** `npm --prefix server ci --dry-run --ignore-scripts` $\to$ **PASS** (Up to date).
- **Git Format Verification:** `git diff --check` $\to$ **PASS** (0 whitespace/formatting errors).

---

## 4. Outstanding Compulsory Deliverables & Incomplete Systems

In compliance with graduation audit rules, the following compulsory items are explicitly identified as **incomplete, unverified, or outstanding**:

| Requirement | Current Status | Detailed Gap & Next Action |
| :--- | :---: | :--- |
| **Android Development Build (`R15.1`)** | **PENDING** | Compulsory requirement. Standalone preview APK exists, but local `expo-dev-client` development build is not yet configured or built. |
| **Read/Write Replica Routing (`R11.2`)** | **PENDING** | Compulsory backend requirement. Single database instance active; read/write replica routing with read-your-writes guarantees is unbuilt. |
| **Redis Caching for Rosters/Calendars (`R11.3`)** | **PENDING** | Compulsory backend requirement. No Redis cluster is active; roster and shift queries hit PostgreSQL directly without cache invalidation. |
| **Two-Database Sharding Simulation (`R12.2`)** | **PENDING** | Compulsory requirement. `SHARDING.md` design exists, but functional two-database PostgreSQL sharding simulation script has not been implemented. |
| **Shift Swap Request & Approval Workflow (`R04.3, R04.4`)** | **PENDING** | Compulsory requirement. Peer-to-peer staff shift swap requests and manager approval workflows are unbuilt. |
| **Activity Feed Keyset Cursor Pagination (`R05.1–R05.7`)** | **PENDING** | Compulsory requirement. Chronological feed model, composite `[timestamp, id]` cursor, 10k seed, and before/after `EXPLAIN ANALYZE` proof are unbuilt. |
| **TanStack Query & Offline State (`R06.1–R06.5`)** | **PENDING** | Compulsory requirement. `@tanstack/react-query` is not installed; optimistic UI rollbacks and offline shift persistence are unbuilt. |
| **Push Notifications & Delay Queue (`R08.1–R08.7`)** | **PENDING** | Compulsory requirement. Push token registration, notification retry worker, and quiet-hours delay queue are unbuilt. |
| **Cross-Device Settings Sync (`R09.1–R09.5`)** | **PENDING** | Compulsory requirement. Server-owned settings model and foreground synchronization are unbuilt. |
| **Redis Distributed Rate Limiting (`R10.4, R10.7`)** | **PENDING** | Compulsory requirement. Sliding-window rate limiting for auth, reset, invitations, and billing is unbuilt. |
| **Live Payment & Reconciliation Certification (`R07`)** | **FAIL-CLOSED** | `DEMO_MODE=true` blocks checkout and webhooks (HTTP 403). Webhook worker is inactive on Vercel. Payment reconciliation is uncertified end-to-end. |
| **Database Integration Test Execution (`12 Items`)** | **UNVERIFIED** | 12 requirements await test runner output from skipped integration suites (`auth.integration.test.ts`, `shift.integration.test.ts`, etc.). |

---

## 5. Required Submission Artifacts Checklist

Before final graduation panel review, the student must capture and upload the following external deliverables:

- [ ] **Android Demonstration Video (Compulsory):**
  - **3-minute walkthrough video** recorded on physical Android hardware demonstrating:
    1. App opening from the Android home screen.
    2. Password visibility toggle tested on Login screen.
    3. User authentication against the live Vercel backend.
    4. Loading team dashboard and shift roster from Neon PostgreSQL.
    5. Scheduling or updating a shift live.
    6. Signing out.
- [ ] **Personal Learning Reflection (`LEARNING-LOG.md`):**
  - Complete all bracketed prompts in [LEARNING-LOG.md](../LEARNING-LOG.md) reflecting on architectural decisions, trade-offs, and lessons learned.
- [ ] **Technical LinkedIn Post:**
  - Decision-focused technical post highlighting engineering trade-offs, architecture choices, and project outcomes.
- [ ] **Engineering Portfolio Case Study:**
  - Written case study detailing architecture, database schema, concurrency controls, challenges, and solutions.
- [ ] **Target Company Outreach List (Section 2.5 of Brief):**
  - Compile structured list of **30 target companies**, technical founders, or engineering managers in the scheduling, workforce management, or HR-tech space.
- [ ] **Submission Synchronization (`SUBMISSION.md`):**
  - Update target `final-task-omotola-bello` repository `SUBMISSION.md` with verified live URLs and honest gap disclosures.
