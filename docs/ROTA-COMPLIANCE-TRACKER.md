# ROTA — Permanent Graduation Compliance Tracker

> **Dev and Design HQ — Product Design and Engineering Bootcamp**<br>
> **Final Graduation Acceptance Tracker (R00 – R17)**<br>
> **Repository:** `C:\Users\USER\rota-mobile`<br>
> **Last Updated:** November 2026<br>
> **Audit Status:** Rigorous Independent Verification & Baseline Commit (Task R01.5)<br>
> **Compulsory Acceptance Requirements (99 total):** 14 DONE | 12 UNVERIFIED | 29 PARTIAL | 44 PENDING<br>
> **Optional Post-Graduation Milestones (1 total):** 0 DONE | 0 UNVERIFIED | 0 PARTIAL | 1 PENDING<br>
> **Grand Total Tracked Items:** 100 Subrequirements (14 DONE, 12 UNVERIFIED, 29 PARTIAL, 45 PENDING)

---

## 1. Document Purpose & Audit Standards

This document is the permanent single source of truth tracking graduation compliance against the formal Dev and Design HQ Rota project specification.

### Audit Invariant Rules
1. **Strict Realism & Zero False Claims:** No requirement is marked `DONE` unless its implementation, automated tests, deployment state, and concrete direct supporting evidence are fully verified.
2. **Multi-Dimensional Verification:** Each requirement is evaluated across four distinct dimensions:
   - **Implemented (`Impl`):** Core application code, database schema, or mobile UI components exist in the repository.
   - **Tested (`Test`):** Automated unit, integration, or physical device end-to-end test execution has passed and is documented with verifiable test output.
   - **Deployed (`Dep`):** Active in live Vercel production or compiled into the distributed standalone Android APK artifact (`N/A` for local development tools).
   - **Evidenced (`Evid`):** Concrete log outputs, benchmark figures, HTTP responses, or relative file citations are recorded.
3. **Classification Taxonomy:**
   - **`DONE`:** All applicable verification dimensions (`Impl`, `Test`, `Dep`, `Evid`) are verified `YES` with direct, reproducible supporting evidence (executed test suite outputs, active network responses, verified build IDs, verified git commands).
   - **`UNVERIFIED`:** Implementation exists in code or was verbally reported, but lacks direct supporting evidence (e.g. database integration suites were skipped, physical device telemetry was not committed as logs, or automated component tests were not executed).
   - **`PARTIAL`:** Implementation is incomplete, has missing capabilities, is blocked by environment configuration (e.g. demo mode blocking live webhooks), or is an uncommitted local working tree draft.
   - **`PENDING`:** Not yet implemented; planned for future execution.
4. **Separation of Compulsory Requirements from Optional Milestones:** Compulsory graduation requirements are strictly segregated from optional post-graduation scalability milestones. Requirement counts are reported factually without presenting the result as an official graduation grade or score.
5. **Local Uncommitted Draft Invariant:** All documentation files created in the working tree (`README.md`, `ARCHITECTURE.md`, `STATE.md`, `SECURITY.md`, `SHARDING.md`, `LEARNING-LOG.md`, `docs/ROTA-SUBMISSION-EVIDENCE.md`) are local uncommitted drafts requiring final review and approval. They are not presented as committed or publicly accessible on GitHub.
6. **Safety & Security Invariants:** Private environment variables, signing keys, credentials, and active Git stashes (`stash@{0}`) remain strictly protected and uncommitted.

---

## 2. Identified Inconsistencies & Corrective Disclosures

Before evaluating the individual requirements, the following ten technical discrepancies and audit disclosures are formally recorded:

1. **Health Endpoint Limitation:** `GET /api/v1/health` verifies process uptime and Express routing, but **does not query Neon or return `database: connected`**. Prior documentation incorrectly claimed it checked database connectivity.
2. **Demo Video Duration:** The graduation specification mandates a **3-minute demonstration video**, not 1–2 minutes.
3. **Database Sharding Reality:** The design document `SHARDING.md` provides an architectural strategy only. It **does not satisfy the required functional two-database PostgreSQL sharding simulation**.
4. **Test Coverage Scope & Skipped Suites:** The 52 passing backend tests validate billing math, proration, fail-closed demo mode, and RBAC permissions. They **do not prove** swap requests, activity feed cursor performance, rate limiting, or load benchmarks. Furthermore, all database-dependent integration test suites (`auth.integration.test.ts`, `shift.integration.test.ts`, `team.integration.test.ts`, `membership.integration.test.ts`, `billing.integration.test.ts`, `webhook-worker.integration.test.ts`, etc.) were skipped during non-destructive test execution.
5. **Preview APK vs. Development Build & Reproducibility:** The compiled EAS preview build (`buildType: apk`, Build ID `222cb397`) provides a distributable standalone package, but **is not equivalent to a functional development build (`expo-dev-client`)** required by compulsory requirement R15.1. Additionally, a single successful cloud build does not prove full multi-build CI reproducibility.
6. **Local Build Configuration Drift Resolved:** Uncommitted modifications to `app/app.json`, `app/eas.json`, and `app/.gitignore` containing active EAS project linkage (`bellonaire`) and local credential ignores were safely reconciled, committed, and pushed as commit `9864047`.
7. **Shift Cancellation Metadata Implementation:** Shift cancellation in `server/src/services/shift.service.ts` records auditable user attribution (`cancelledByUserId`), cancellation timestamp (`cancelledAt`), optimistic concurrency check (`updatedAt`), and RBAC permission enforcement. A separate cancellation reason field is **not required by the original brief** and is not mandated.
8. **Live Webhook Ingestion Blocked:** While HMAC-SHA512 webhook signature verification and raw buffer handling are implemented in `billing.controller.ts`, **live webhook ingestion is blocked** in production because `DEMO_MODE=true` immediately rejects all incoming webhook requests with HTTP 403 Forbidden.
9. **Financial Idempotency & Ledger Immutability Proof:** Prisma models for `BillingIdempotencyKey`, `BillingLedgerTransaction`, and `BillingLedgerEntry` exist, but end-to-end concurrency tests proving duplicate request suppression under race conditions and database-level immutability triggers (preventing UPDATE/DELETE) have not been executed or proven.
10. **Connection Pooling Benchmark Data:** PgBouncer connection pooling is active on Neon via `DATABASE_URL`, but **no empirical connection latency or cold-start benchmark measurements have been recorded**.

---

## 3. Compulsory Graduation Compliance Matrix (R00 – R17)

### R00 — Baseline Foundation & Live Operational Evidence

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R00.1** | Live deployed backend on Vercel Serverless handling HTTPS traffic. | YES | YES | YES | YES | **DONE** | [Health Endpoint](https://rota-api-demo.vercel.app/api/v1/health) | None. Direct HTTP GET probe confirmed responding with HTTP 200. |
| **R00.2** | Managed PostgreSQL database provisioned on Neon with connection pooling. | YES | NO | YES | PARTIAL | **UNVERIFIED** | [schema.prisma](../server/prisma/schema.prisma) | Neon connection pooling URL configured, but direct database connectivity query has not been executed or benchmarked in this audit. |
| **R00.3** | Standalone Android APK successfully compiled via Expo Application Services. | YES | YES | YES | YES | **DONE** | [EAS Build Artifact](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8) | None. Standalone APK package generated successfully (Build ID `222cb397`). |
| **R00.4** | Physical device user testing: Authenticate into live backend from installed APK. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [ROTA-SUBMISSION-EVIDENCE.md](./ROTA-SUBMISSION-EVIDENCE.md) *(Local draft)* | User sign-in verbally reported, but physical device telemetry, network trace, or video recording has not been committed as evidence. |
| **R00.5** | Physical device user testing: Load active team dashboard and persist a shift update. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [app index.tsx](../app/src/app/(app)/index.tsx) | Shift update verbally reported, but physical device telemetry or database state snapshot has not been committed as evidence. |

---

### R01 — Repository Hygiene, Build Configuration, Secret Protection & Git Safety

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R01.1** | Permanent graduation compliance tracker established at `docs/ROTA-COMPLIANCE-TRACKER.md`. | YES | YES | N/A | YES | **DONE** | [ROTA-COMPLIANCE-TRACKER.md](./ROTA-COMPLIANCE-TRACKER.md) *(Local draft)* | None. Created and maintained as single source of truth in working tree. |
| **R01.2** | Strict secret protection: Zero exposed secrets, private env keys, keystores, or credentials in Git history or bundles. | PARTIAL | NO | N/A | PARTIAL | **PARTIAL** | [app .gitignore](../app/.gitignore), [server .gitignore](../server/.gitignore) | Gitignore patterns protect active files, but no automated secret scan (e.g. gitleaks/trufflehog) has audited full Git history or unpacked APK. |
| **R01.3** | Git safety: Protected Git stash preserved intact without premature application or deletion. | YES | YES | N/A | YES | **DONE** | Local Git repository | Verified via `git stash list`: `stash@{0}: WIP 5E.3B unsafe renewal handler`. Must remain unapplied. |
| **R01.4** | Safe reconciliation of uncommitted build configuration files (`app.json`, `eas.json`, `.gitignore`). | YES | YES | YES | YES | **DONE** | [app.json](../app/app.json), [eas.json](../app/eas.json), [app .gitignore](../app/.gitignore) | None. Safely reconciled and committed as `9864047` (`chore: preserve verified Android EAS build configuration`). |
| **R01.5** | Node.js 22.x LTS runtime pinned with synchronized `package-lock.json` clean-install consistency. | YES | YES | YES | YES | **DONE** | [package.json](../server/package.json), [package-lock.json](../server/package-lock.json) | None. `"engines": { "node": "22.x" }` pinned and lockfile verified via `npm ci --dry-run`. |
| **R01.6** | Client public environment variable audit: Exhaustive verification that `EXPO_PUBLIC_API_URL` is the sole `EXPO_PUBLIC_` variable and contains no sensitive credentials. | YES | YES | YES | YES | **DONE** | [app.config.js](../app/app.config.js), [config.ts](../app/src/constants/config.ts) | None. Verified via `git grep`: only `EXPO_PUBLIC_API_URL` is exposed, validated to require HTTPS and reject private addresses. |

---

### R02 — Authentication, Tokens, Credentials & Session Management

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R02.1** | Email and password authentication with bcrypt password hashing (min 8 chars). | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [auth.service.ts](../server/src/services/auth.service.ts) | Implementation exists with bcrypt 12 salt rounds, but `auth.integration.test.ts` was skipped; lacks automated test execution evidence. |
| **R02.2** | Accessible password visibility eye toggle on mobile auth forms (44×44 touch target, accessible labels). | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [FormField.tsx](../app/src/components/common/FormField.tsx) | Implemented in FormField with custom vector EyeIcon and passed typecheck, but automated component/accessibility tests were not executed. |
| **R02.3** | Google OAuth OR Magic Link passwordless authentication implemented. | NO | NO | NO | NO | **PENDING** | [auth.routes.ts](../server/src/routes/auth.routes.ts) | Gap: Neither Google OAuth nor Magic Link passwordless flow is implemented. |
| **R02.4** | Dual-token rotation with SHA-256 hashed refresh tokens and automatic token-family reuse invalidation. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [auth.service.ts](../server/src/services/auth.service.ts) | Token rotation and family revocation implemented, but `auth.integration.test.ts` was skipped; lacks executed test evidence. |
| **R02.5** | Hardware-backed secure credential persistence via `expo-secure-store` on mobile devices. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [AuthContext.tsx](../app/src/context/AuthContext.tsx) | SecureStore integration in code, but automated device test evidence has not been recorded. |
| **R02.6** | Global session termination (`POST /api/v1/auth/logout-all`) revoking all active user refresh sessions. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [auth.routes.ts](../server/src/routes/auth.routes.ts) | Endpoint implemented in routes and services, but multi-session revocation test suite was skipped. |
| **R02.7** | Self-service password reset workflow (reset token generation, email dispatch, expiration, password update). | NO | NO | NO | NO | **PENDING** | [auth.routes.ts](../server/src/routes/auth.routes.ts) | Gap: No password reset endpoints, tokens, or email dispatch handlers exist. |
| **R02.8** | Automated token lifecycle integration test suite: Test proof verifying 15-minute access token expiration, refresh rotation, reuse rejection cascading revocation, and logout-all invalidation. | YES | PARTIAL | N/A | PARTIAL | **UNVERIFIED** | [auth.integration.test.ts](../server/src/auth/auth.integration.test.ts) | Comprehensive integration suite written, but unexecuted in reported test suite due to non-destructive database constraints. |

---

### R03 — Multi-Tenant Isolation, RBAC & Team Access Control

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R03.1** | Multi-tenant data isolation: Every team query strictly validates `TeamMembership` and scopes by `teamId`. Missing team membership returns HTTP 404 (preventing tenant enumeration); insufficient permissions returns HTTP 403. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [teamAuthorization.ts](../server/src/middleware/teamAuthorization.ts) | Middleware returns 404 for missing membership and 403 for permission denial, but database integration tests were skipped. |
| **R03.2** | Centralized Role-Based Access Control matrix (`OWNER`, `MANAGER`, `STAFF`) scoped to `TeamMembership`. | YES | YES | YES | YES | **DONE** | [permissions.ts](../server/src/rbac/permissions.ts), [permissions.test.ts](../server/src/rbac/permissions.test.ts) | None. Direct test execution proof: 7 passing unit tests in `permissions.test.ts`. |
| **R03.3** | Team member invitations via email and secure invite links. | NO | NO | NO | NO | **PENDING** | [team.routes.ts](../server/src/routes/team.routes.ts) | Gap: Team members are added directly by User ID. Invitation tokens and email invites unbuilt. |
| **R03.4** | Deep link routing into the mobile application to accept team invitations directly. | NO | NO | NO | NO | **PENDING** | [app _layout.tsx](../app/src/app/_layout.tsx) | Gap: Deep link invitation handler unbuilt. |
| **R03.5** | Automated authorization denial test proof: Negative test suite asserting staff role cannot create, edit, or cancel shifts (HTTP 403), cannot access billing endpoints (HTTP 403), and cannot read or write data of a foreign team (HTTP 404/403). | PARTIAL | PARTIAL | YES | PARTIAL | **PARTIAL** | [permissions.test.ts](../server/src/rbac/permissions.test.ts) | Unit tests prove permission matrix denial, but route-level integration tests covering cross-team tenant denial were skipped. |

---

### R04 — Shift Scheduling, Lifecycle & Peer Swap Requests

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R04.1** | Manager/Owner shift creation, scheduling, date filtering, and reassignment. | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [shift.controller.ts](../server/src/controllers/shift.controller.ts) | Implemented in service/controller, but `shift.integration.test.ts` was skipped; lacks executed test evidence. |
| **R04.2** | Shift cancellation audit metadata and RBAC: Shift cancellation records auditable actor (`cancelledByUserId`), timestamp (`cancelledAt`), optimistic concurrency check (`updatedAt`), and enforces manager/owner RBAC permissions (no cancellation reason field required by brief). | YES | PARTIAL | YES | PARTIAL | **UNVERIFIED** | [shift.service.ts](../server/src/services/shift.service.ts), [schema.prisma](../server/prisma/schema.prisma) | Cancellation audit metadata and RBAC check are implemented in `shift.service.ts`, but integration tests were skipped. |
| **R04.3** | Staff peer-to-peer shift swap request submission workflow. | NO | NO | NO | NO | **PENDING** | [schema.prisma](../server/prisma/schema.prisma) | Gap: No `ShiftSwapRequest` table, route, or UI screen exists. |
| **R04.4** | Manager review, conflict detection, approval, and rejection workflow for shift swap requests. | NO | NO | NO | NO | **PENDING** | [shift.controller.ts](../server/src/controllers/shift.controller.ts) | Gap: Manager swap approval and conflict detection unbuilt. |

---

### R05 — Activity Feed, Keyset Cursor Pagination & Query Analysis

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R05.1** | Chronological activity feed capturing team audit events (shifts, roster changes, swaps). | NO | NO | NO | NO | **PENDING** | [schema.prisma](../server/prisma/schema.prisma) | Gap: No activity feed model, audit triggers, or endpoint exist. |
| **R05.2** | Keyset / cursor pagination using composite `[timestamp, id]` cursor and supporting composite index. | NO | NO | NO | NO | **PENDING** | [team.routes.ts](../server/src/routes/team.routes.ts) | Gap: Keyset cursor pagination unbuilt (shifts currently use offset pagination). |
| **R05.3** | Synthetic database seed populating 10,000+ realistic activity feed records for performance testing. | NO | NO | NO | NO | **PENDING** | [seed.ts](../server/prisma/seed.ts) | Gap: Seed script only provisions basic auth fixtures; 10k seed unbuilt. |
| **R05.4** | Empirical query optimization evidence: Before and after `EXPLAIN ANALYZE` benchmarks for cursor vs offset pagination. | NO | NO | NO | NO | **PENDING** | [load-tests README.md](../load-tests/README.md) | Gap: No `EXPLAIN ANALYZE` execution logs captured. |
| **R05.5** | Mobile client infinite scroll feed with distinct loading, empty, error, and end-of-list states. | NO | NO | NO | NO | **PENDING** | [app index.tsx](../app/src/app/(app)/index.tsx) | Gap: Activity feed UI unbuilt. |
| **R05.6** | Mobile feed UI performance & reliability: Native pull-to-refresh (`RefreshControl`), in-flight duplicate request debouncing/prevention, and documented architectural justification for `FlatList` vs alternatives. | NO | NO | NO | NO | **PENDING** | [app index.tsx](../app/src/app/(app)/index.tsx) | Gap: Pull-to-refresh, in-flight request debouncing, and list component justification unbuilt. |
| **R05.7** | Database indexing verification: Composite B-tree index `[teamId, createdAt DESC, id DESC]` benchmarked with `EXPLAIN ANALYZE` before and after index application on 10,000 records. | NO | NO | NO | NO | **PENDING** | [load-tests README.md](../load-tests/README.md) | Gap: Index benchmarking unperformed. |

---

### R06 — Client State, TanStack Query, Caching & Offline Invariants

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R06.1** | Integration of TanStack Query (`@tanstack/react-query`) for client-side query caching and deduplication. | NO | NO | NO | NO | **PENDING** | [package.json](../app/package.json) | Gap: App uses manual `useState`/`useEffect` hooks. `@tanstack/react-query` uninstalled. |
| **R06.2** | Strict separation of client, server, and persistent state across memory, context, and storage. | PARTIAL | NO | YES | PARTIAL | **PARTIAL** | [AuthContext.tsx](../app/src/context/AuthContext.tsx) | Auth and teams separated, but persistent query cache layer is unbuilt. |
| **R06.3** | Offline shift viewing with client-side synchronization timestamp and offline status indicator. | PARTIAL | NO | YES | PARTIAL | **PARTIAL** | [app index.tsx](../app/src/app/(app)/index.tsx) | Shifts remain in memory during session, but offline persistent cache and offline banner are unbuilt. |
| **R06.4** | Optimistic UI updates with automatic rollback on network mutation errors (swaps and settings). | NO | NO | NO | NO | **PENDING** | [shiftService.ts](../app/src/services/api/shiftService.ts) | Gap: Mutations await server response; optimistic rollback unbuilt. |
| **R06.5** | Explicit TanStack Query cache policies: Configured `staleTime`, `gcTime`, retry backoff, window focus refetch rules, and structured query key factories across shifts, team members, and settings. | NO | NO | NO | NO | **PENDING** | [app/src/](../app/src/) | Gap: Cache policy configuration and query key factories unbuilt. |

---

### R07 — Subscription Billing, Proration, Webhooks & Financial Invariants

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R07.1** | Exact subscription tiers (Starter, Team, Business) with integer cent minor-unit pricing. | YES | YES | YES | YES | **DONE** | [pricing.ts](../server/src/billing/pricing.ts), [pricing.test.ts](../server/src/billing/pricing.test.ts) | None. Direct test execution proof: 24 passing unit tests in `pricing.test.ts`. |
| **R07.2** | Proration engine covering 8+ distinct upgrade, downgrade, seat change, and leap-year cases. | YES | YES | YES | YES | **DONE** | [pricing.ts](../server/src/billing/pricing.ts), [billing-calendar.test.ts](../server/src/billing/billing-calendar.test.ts) | None. Direct test execution proof: 19 calendar unit tests + 24 pricing tests pass covering all leap-year and anniversary edge cases. |
| **R07.3** | Signed webhook ingestion verifying HMAC-SHA512 signature over raw request buffers. | YES | PARTIAL | YES | PARTIAL | **PARTIAL** | [billing.controller.ts](../server/src/controllers/billing.controller.ts) | HMAC verification and raw buffer logic exist, but live ingestion is blocked in production by `DEMO_MODE=true` (HTTP 403). |
| **R07.4** | Fail-closed demonstration boundary: `DEMO_MODE=true` returning HTTP 403 on checkout and webhooks. | YES | YES | YES | YES | **DONE** | [billing.controller.ts](../server/src/controllers/billing.controller.ts), [demo-mode.test.ts](../server/src/billing/demo-mode.test.ts) | None. Direct test execution proof: 2 passing unit tests in `demo-mode.test.ts`. |
| **R07.5** | Idempotency enforcement via `BillingIdempotencyKey` preventing duplicate transaction execution. | PARTIAL | PARTIAL | YES | PARTIAL | **PARTIAL** | [schema.prisma](../server/prisma/schema.prisma) | Schema model exists, but end-to-end race-condition concurrency test proving duplicate suppression is unexecuted. |
| **R07.6** | Immutable double-entry financial ledger (`BillingLedgerTransaction` + `BillingLedgerEntry`). | PARTIAL | PARTIAL | YES | PARTIAL | **PARTIAL** | [schema.prisma](../server/prisma/schema.prisma) | Tables exist with debit/credit balance constraint, but database trigger preventing UPDATE/DELETE and posting tests are unproven. |
| **R07.7** | Subscription grace periods and staff seat entitlement enforcement (`assertSubscriptionEntitlement`). | PARTIAL | PARTIAL | YES | PARTIAL | **PARTIAL** | [subscription-entitlement.service.ts](../server/src/services/subscription-entitlement.service.ts) | Service logic implemented, but integration tests were unexecuted during graduation test run. |
| **R07.8** | Asynchronous webhook event processing queue and reconciliation background worker. | PARTIAL | PARTIAL | NO | PARTIAL | **PARTIAL** | [webhook-worker.ts](../server/src/jobs/webhook-worker.ts), [webhook-event-queue.ts](../server/src/jobs/webhook-event-queue.ts) | PostgreSQL-backed lease queue and worker exist in code, but worker is inactive on serverless Vercel. |
| **R07.9** | End-to-end subscription lifecycle & renewal handling: Automated test proof of renewal failure, transition into grace period, automatic restriction on non-payment, and synchronous ledger posting. | PARTIAL | NO | NO | PARTIAL | **PARTIAL** | [paystack-renewal.service.ts](../server/src/services/paystack-renewal.service.ts) | Renewal service exists, but end-to-end lifecycle integration test suite was skipped. |
| **R07.10** | Mobile app store compliance disclosure: Documented policy in architecture clarifying external SaaS billing exemption under Apple App Store Review Guideline 3.1.3(c) / Google Play Billing policies for B2B shift tools. | PARTIAL | N/A | N/A | PARTIAL | **PARTIAL** | [ARCHITECTURE.md](../ARCHITECTURE.md) *(Local draft)* | Documented in uncommitted ARCHITECTURE.md draft; requires final review. |

---

### R08 — Push Notifications, Dispatch Worker & User Preferences

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R08.1** | Device push notification token registration and association with user profiles. | NO | NO | NO | NO | **PENDING** | [schema.prisma](../server/prisma/schema.prisma) | Gap: No push token model or registration endpoint exists. |
| **R08.2** | Automated background notification dispatches for shift schedules, cancellations, and swap approvals. | NO | NO | NO | NO | **PENDING** | [server/src/jobs/](../server/src/jobs/) | Gap: Notification dispatch pipeline unbuilt. |
| **R08.3** | Resilient notification delivery with exponential backoff retries and invalid token pruning. | NO | NO | NO | NO | **PENDING** | [server/src/jobs/](../server/src/jobs/) | Gap: Push retry worker unbuilt. |
| **R08.4** | Deep link navigation routing directly to the affected shift from incoming push notifications. | NO | NO | NO | NO | **PENDING** | [app _layout.tsx](../app/src/app/_layout.tsx) | Gap: Notification deep link scheme unbuilt. |
| **R08.5** | User notification preference center supporting granular alert category toggles and quiet hours schedule. | NO | NO | NO | NO | **PENDING** | [app index.tsx](../app/src/app/(app)/index.tsx) | Gap: Notification preferences UI and storage unbuilt. |
| **R08.6** | Multi-device token management: User-to-device 1:N relationship allowing multiple active devices per user account, with automatic cleanup of expired tokens on `DeviceNotRegistered` errors. | NO | NO | NO | NO | **PENDING** | [schema.prisma](../server/prisma/schema.prisma) | Gap: Multi-device token table and cleanup unbuilt. |
| **R08.7** | Notification channels & localized quiet hours queuing: Segregated notification categories (shifts, swaps, billing) with server-side quiet hours evaluation respecting user timezone; non-urgent notifications are **delayed and queued until the permitted delivery window**, never discarded or dropped. | NO | NO | NO | NO | **PENDING** | [server/src/jobs/](../server/src/jobs/) | Gap: Notification channels and quiet-hour delay queue unbuilt. |

---

### R09 — Cross-Device Settings, Synchronization & Conflict Handling

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R09.1** | Server-owned user preferences and settings data model. | NO | NO | NO | NO | **PENDING** | [schema.prisma](../server/prisma/schema.prisma) | Gap: No `UserSettings` table exists in PostgreSQL. |
| **R09.2** | Conflict resolution using server-validated timestamps for concurrent settings modifications across devices. | NO | NO | NO | NO | **PENDING** | [server/src/routes/](../server/src/routes/) | Gap: Settings sync conflict resolution unbuilt. |
| **R09.3** | Configurable user preferences: Timezone, interface theme (light/dark/system), and language. | NO | NO | NO | NO | **PENDING** | [theme.ts](../app/src/constants/theme.ts) | Gap: User preference storage and UI unbuilt. |
| **R09.4** | Notification type subscriptions with optimistic UI rollback on client mutation error. | NO | NO | NO | NO | **PENDING** | [app index.tsx](../app/src/app/(app)/index.tsx) | Gap: Settings rollback unbuilt. |
| **R09.5** | Foreground settings synchronization: Mobile app refetches user settings upon app state returning to active/foreground, rejecting stale client timestamps in favor of server-authoritative `updatedAt`. | NO | NO | NO | NO | **PENDING** | [app/src/](../app/src/) | Gap: AppState listener and foreground sync unbuilt. |

---

### R10 — API Security, Strict Validation & Rate Limiting

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R10.1** | Strict input schema validation on all request params, queries, and bodies via Zod. | YES | PARTIAL | YES | PARTIAL | **PARTIAL** | [validateRequest.ts](../server/src/middleware/validateRequest.ts) | Zod schemas and validation middleware implemented across all routes, but comprehensive HTTP 400 rejection integration suite was skipped. |
| **R10.2** | Defense-in-depth authorization pipeline enforcing token validity, tenant membership, and permissions. | YES | PARTIAL | YES | PARTIAL | **PARTIAL** | [teamAuthorization.ts](../server/src/middleware/teamAuthorization.ts) | Middleware pipeline active, but integration tests were unexecuted during test report. |
| **R10.3** | Automated test suite verifying security invariants (auth rejection, RBAC denial, demo mode). | YES | YES | YES | YES | **DONE** | [permissions.test.ts](../server/src/rbac/permissions.test.ts), [demo-mode.test.ts](../server/src/billing/demo-mode.test.ts) | None. Direct test execution proof: 7 RBAC tests and 2 demo-mode security boundary tests pass. |
| **R10.4** | Distributed API rate limiting implemented via Redis sliding window or token bucket algorithm. | NO | NO | NO | NO | **PENDING** | [server/src/middleware/](../server/src/middleware/) | Gap: No Redis rate limiting middleware is installed. |
| **R10.5** | Comprehensive secrets audit confirming zero plaintext credentials in client bundles, server repository, or public docs. | PARTIAL | NO | N/A | PARTIAL | **PARTIAL** | [.gitignore](../.gitignore) | Active working tree is clean, but automated deep git history audit (gitleaks) and decompiled APK dex scan have not been performed. |
| **R10.6** | Comprehensive threat model and mitigation matrix addressing 8 distinct security attack vectors. | YES | YES | N/A | PARTIAL | **PARTIAL** | [SECURITY.md](../SECURITY.md) *(Local draft)* | Document covers 8 vectors (replay, IDOR, escalation, injection, etc.), but document is an uncommitted local draft. |
| **R10.7** | Granular Redis rate limits: Distinct sliding window rate limit tiers for sensitive operations: authentication/login (5 req/min), password reset requests (3 req/hour), team invitations (10 req/hour), and billing operations (10 req/min). | NO | NO | NO | NO | **PENDING** | [server/src/middleware/](../server/src/middleware/) | Gap: Granular Redis rate limiting tiers unbuilt. |

---

### R11 — Scalability, Caching & Data Layer Architecture

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R11.1** | PgBouncer connection pooling architecture and serverless cold-start justification. | YES | NO | YES | PARTIAL | **PARTIAL** | [ARCHITECTURE.md](../ARCHITECTURE.md) *(Local draft)* | PgBouncer pooled URL configured, but empirical latency benchmarks and cold-start measurements are unrecorded. |
| **R11.2** | Read/write replica routing with read-your-writes consistency guarantees (e.g. routing mutation writes to primary and subsequent reads within same session/window to primary before falling back to read replicas). | NO | NO | NO | NO | **PENDING** | [prisma.ts](../server/src/database/prisma.ts) | Gap: Compulsory backend requirement; currently operating single database instance without read/write replica routing. |
| **R11.3** | Distributed Redis caching of team rosters and shift calendars, with explicit tag-based or key-based cache invalidation on roster/shift mutations. | NO | NO | NO | NO | **PENDING** | [server/src/services/](../server/src/services/) | Gap: Compulsory backend requirement; Redis caching layer for rosters/calendars and mutation invalidation unbuilt. |
| **R11.4** | Asynchronous queue architecture for decoupled background workloads (webhook reconciliation & tasks). | YES | PARTIAL | NO | PARTIAL | **PARTIAL** | [webhook-event-queue.ts](../server/src/jobs/webhook-event-queue.ts), [webhook-worker.ts](../server/src/jobs/webhook-worker.ts) | PostgreSQL lease-based webhook queue exists in code, but worker is inactive on serverless Vercel and Redis queue is unbuilt. |
| **R11.5** | Production observability: Structured request logging, error tracking, and performance metrics. | PARTIAL | NO | YES | PARTIAL | **PARTIAL** | [errorHandler.ts](../server/src/middleware/errorHandler.ts) | Basic console and error logs exist, but OpenTelemetry and production APM are unbuilt. |
| **R11.6** | Connection pool sizing & PgBouncer tuning: Explicit connection limit formulas documented for serverless concurrency (`pool_timeout`, `connection_limit`), preventing connection exhaustion on Neon under high lambda scaling. | PARTIAL | NO | PARTIAL | PARTIAL | **PARTIAL** | [ARCHITECTURE.md](../ARCHITECTURE.md) *(Local draft)* | Discussed in uncommitted draft; formal pool sizing stress tests unexecuted. |
| **R11.7** | Production observability pipeline: Correlation request IDs (`X-Request-ID`), structured JSON log outputs with request latency in milliseconds, background job execution duration logs, and client/server exception reporting. | PARTIAL | NO | YES | PARTIAL | **PARTIAL** | [errorHandler.ts](../server/src/middleware/errorHandler.ts) | Error handler returns JSON, but correlation ID middleware and latency logging are unbuilt. |

---

### R12 — Multi-Tenant Sharding Strategy & Simulation

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R12.1** | Theoretical tenant-based horizontal partitioning strategy documented in `SHARDING.md`. | YES | N/A | N/A | PARTIAL | **PARTIAL** | [SHARDING.md](../SHARDING.md) *(Local draft)* | Documents partition key selection (`teamId`) and roadmap, but document is an uncommitted local draft. |
| **R12.2** | Functional two-database PostgreSQL sharding simulation demonstrating routing by `teamId`. | NO | NO | NO | NO | **PENDING** | [SHARDING.md](../SHARDING.md) *(Local draft)* | Gap: Compulsory requirement; two-database simulation environment and routing script not yet implemented. |

---

### R13 — Performance Benchmarks, Query Plans & Load Testing

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R13.1** | Automated test execution proof for security, proration, and domain invariant test suites. | YES | PARTIAL | N/A | PARTIAL | **PARTIAL** | [ROTA-SUBMISSION-EVIDENCE.md](./ROTA-SUBMISSION-EVIDENCE.md) *(Local draft)* | 52 offline unit tests executed and passed across 4 suites. All database integration suites were skipped during test run. |
| **R13.2** | Query execution plan benchmarks with `EXPLAIN ANALYZE` metrics for high-volume shift and membership queries. | NO | NO | NO | NO | **PENDING** | [load-tests README.md](../load-tests/README.md) | Gap: No query execution plan evidence captured. |
| **R13.3** | k6 load testing execution simulating 200 Virtual Users (VU) on the activity feed endpoint. | NO | NO | NO | NO | **PENDING** | [load-tests README.md](../load-tests/README.md) | Gap: `load-tests/` contains placeholder only; no runs executed. |
| **R13.4** | Comparative before-and-after caching performance analysis under 200 VU load. | NO | NO | NO | NO | **PENDING** | [load-tests README.md](../load-tests/README.md) | Gap: Benchmark comparison unbuilt. |

---

### R14 — Technical Documentation & Student Reflection

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R14.1** | Up-to-date root `README.md` reflecting architecture, tech stack, capabilities, and local development. | YES | YES | N/A | PARTIAL | **PARTIAL** | [README.md](../README.md) *(Local draft)* | Root README updated in working tree, but is an uncommitted local draft requiring content review. |
| **R14.2** | Complete technical specifications suite (`ARCHITECTURE.md`, `STATE.md`, `SECURITY.md`, `SHARDING.md`). | YES | YES | N/A | PARTIAL | **PARTIAL** | Root documentation *(Local drafts)* | All 4 documents drafted in working tree, but are uncommitted drafts requiring content review. |
| **R14.3** | High-level architectural component and data flow diagrams (Mermaid format). | YES | YES | N/A | PARTIAL | **PARTIAL** | [ARCHITECTURE.md](../ARCHITECTURE.md) *(Local draft)* | Mermaid diagrams embedded in uncommitted ARCHITECTURE.md draft. |
| **R14.4** | Personally written student reflection completed in `LEARNING-LOG.md`. | PARTIAL | NO | N/A | PARTIAL | **PARTIAL** | [LEARNING-LOG.md](../LEARNING-LOG.md) *(Local template)* | Template created in working tree. Student must replace bracketed prompts with personal reflections. |
| **R14.5** | README visual media: Inclusion of actual application screenshots, architecture preview diagrams, and direct links to demo media within root `README.md`. | NO | NO | N/A | NO | **PENDING** | [README.md](../README.md) *(Local draft)* | Gap: Media assets and screenshot files unpopulated. |
| **R14.6** | Architectural Decision Records (ADRs): Formal ADR section documenting key architectural trade-offs (e.g. Express on Vercel vs containers, PgBouncer vs direct, single DB vs sharding, raw body capture). | PARTIAL | N/A | N/A | PARTIAL | **PARTIAL** | [ARCHITECTURE.md](../ARCHITECTURE.md) *(Local draft)* | Trade-offs documented in uncommitted ARCHITECTURE.md draft; formal ADR layout pending. |

---

### R15 — Native Mobile Builds & Cloud Distribution

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R15.1** | Functional Expo Android development build (`expo-dev-client`) for local native debugging. | NO | NO | NO | NO | **PENDING** | [package.json](../app/package.json) | Gap: Compulsory mobile requirement; standalone preview APK does not satisfy local development client build. |
| **R15.2** | Standalone Android APK successfully compiled via EAS Cloud Build. | YES | YES | YES | YES | **DONE** | [Build 222cb397](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8) | None. Direct EAS build proof: APK generated, downloaded, and verified on EAS (Build ID `222cb397`). |
| **R15.3** | Reproducible cloud build pipeline with pinned dependencies and zero local build dependencies. | YES | PARTIAL | YES | PARTIAL | **PARTIAL** | [eas.json](../app/eas.json) | Single cloud build succeeded, but automated CI trigger reproducibility across multiple consecutive commits is unproven. |
| **R15.4** | Safe reconciliation and version-control tracking of public mobile configuration (`app.json`, `eas.json`, `.gitignore`). | YES | YES | YES | YES | **DONE** | [app.json](../app/app.json), [eas.json](../app/eas.json), [app .gitignore](../app/.gitignore) | None. Safely reconciled and committed as `9864047` without exposing secrets or disturbing EAS preview build setup. |

---

### R16 — Demonstration Media & Portfolio Case Study

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R16.1** | Complete 3-minute video demonstration showcasing mobile-to-cloud workflows on an Android device. | NO | NO | NO | NO | **PENDING** | Media Host *(External)* | Gap: Compulsory 3-minute video walkthrough must be recorded by the student and uploaded. |
| **R16.2** | Decision-focused technical LinkedIn post highlighting engineering trade-offs and project outcomes. | NO | NO | NO | NO | **PENDING** | LinkedIn *(External)* | Gap: LinkedIn post draft and URL required. |
| **R16.3** | Comprehensive engineering portfolio case study detailing architecture, challenges, and lessons learned. | NO | NO | NO | NO | **PENDING** | Portfolio Site *(External)* | Gap: Written portfolio case study required. |
| **R16.4** | Target company outreach list: Structured list of 30 target companies, technical founders, or engineering managers in the rota/scheduling, workforce management, HR-tech, or B2B SaaS space for portfolio outreach, as required by Section 2.5 of the graduation brief. | NO | NO | NO | NO | **PENDING** | [docs/](../docs/) | Gap: Structured 30-company outreach list uncompiled. |
| **R16.5** | Portfolio case study acceptance criteria: Published engineering article/case study containing live demo links, technical architecture diagrams, database schema breakdown, challenge/solution narratives, and key performance benchmarks. | NO | NO | NO | NO | **PENDING** | Portfolio Site *(External)* | Gap: Published case study unverified. |

---

### R17 — Final Submission Evidence Reconciliation

| ID | Exact Acceptance Criterion | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R17.1** | Thorough audit of all live URLs, GitHub repositories, and build artifacts recorded in evidence docs. | YES | YES | N/A | PARTIAL | **PARTIAL** | [ROTA-SUBMISSION-EVIDENCE.md](./ROTA-SUBMISSION-EVIDENCE.md) *(Local draft)* | Recorded in local uncommitted draft. Requires final updates and staging. |
| **R17.2** | Update and synchronization of `final-task-omotola-bello` `SUBMISSION.md` with accurate verified links and gap disclosures. | NO | NO | NO | NO | **PENDING** | External `SUBMISSION.md` | Gap: Target submission repository must be updated with final links and honest disclosures. |

---

## 4. Optional Enhancements & Post-Graduation Scalability Milestones

The following item represents an advanced multi-shard distributed infrastructure stretch goal. It is tracked independently and is **strictly excluded from compulsory graduation requirement counts**:

| ID | Milestone Description | Impl | Test | Dep | Evid | Status | Evidence Link / File | Gap & Next Action |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **R12.3** | *[Post-Graduation Milestone]* Verification of multi-region cross-shard distributed transaction isolation and global user routing under partitioned operation. | NO | NO | NO | NO | **PENDING** | [SHARDING.md](../SHARDING.md) *(Local draft)* | Multi-shard distributed routing and cross-shard integrity verification is an advanced post-graduation milestone beyond the two-database simulation (R12.2). |

---

## 5. Audit & Verification Inventory

### 5.1 Client Environment Variable Audit (`EXPO_PUBLIC_`)

An exhaustive audit of all client-exposed environment variables was conducted across `app/`:

| Variable Name | Defined In | Consumed By | Validated Value / Purpose | Secret Exposure Risk |
| :--- | :--- | :--- | :--- | :--- |
| `EXPO_PUBLIC_API_URL` | `app/.env.example`, `app/eas.json` | `app/app.config.js`, `app/src/constants/config.ts` | `https://rota-api-demo.vercel.app/api/v1` (Public HTTPS backend endpoint) | **NONE** (Public API URL; build fails if localhost or placeholder) |

*Audit Finding:* No other `EXPO_PUBLIC_` variables exist. No private keys, database URLs, JWT secrets, or payment gateway credentials are leaked into the mobile bundle.

### 5.2 Test Execution Breakdown (52 Executed Unit Tests vs Skipped Integration Suites)

The 52 passing tests cited in prior reports represent **offline unit test suites only**. The full test execution breakdown is as follows:

#### Executed & Passing Offline Unit Test Suites (52 Tests)
1. **`server/src/billing/demo-mode.test.ts` (2 tests):**
   - Checkout rejection with HTTP 403 under `DEMO_MODE=true`.
   - Webhook rejection with HTTP 403 under `DEMO_MODE=true`.
2. **`server/src/rbac/permissions.test.ts` (7 tests):**
   - Centralized RBAC permission checks for `OWNER`, `MANAGER`, and `STAFF`.
   - Positive and negative permission boundaries.
3. **`server/src/billing/pricing.test.ts` (24 tests):**
   - Minor-unit integer cent calculations across Starter, Team, and Business tiers.
   - Upgrade, downgrade, seat additions, and mid-cycle proration math.
4. **`server/src/billing/billing-calendar.test.ts` (19 tests):**
   - Calendar anniversary anchoring, month-end drift prevention, and leap-year proration math.

#### Unexecuted / Skipped Database Integration Suites (10 Suites)
The following 10 integration test suites exist in `server/src/` but were **skipped during non-destructive test runs** because they execute real Prisma queries against the database (the earlier focused 52-test unit run did not execute them, and no claim is made that they passed or failed):
- `server/src/auth/auth.integration.test.ts` (Registration, login, access expiration, refresh token family rotation, logout-all).
- `server/src/teams/team.integration.test.ts` (Team creation, updates, and isolation).
- `server/src/teams/membership.integration.test.ts` (Multi-tenant authorization and membership roles).
- `server/src/teams/shift.integration.test.ts` (Shift creation, scheduling, conflict detection, updates, cancellations).
- `server/src/billing/billing.integration.test.ts` (Billing checkout and subscription status queries).
- `server/src/jobs/webhook-worker.integration.test.ts` (PostgreSQL lease queue consumption and retries).
- `server/src/jobs/webhook-reconciliation.integration.test.ts` (Webhook reconciliation state machine).
- `server/src/services/subscription-entitlement.integration.test.ts` (Staff seat limit assertions).
- `server/src/services/paystack-reconciliation.integration.test.ts` (Paystack transaction reconciliation).
- `server/src/services/provider-plan-reservation.integration.test.ts` (Provider plan reservation and seat quota enforcement).

### 5.3 Entries Awaiting Independent Verification (`UNVERIFIED`)

The following 12 items have code implemented or verbally reported operational success, but require direct, reproducible verification logs or automated test execution before they can be certified as `DONE`:

1. **R00.2 (Neon PostgreSQL Connection):** Requires a dedicated non-destructive live database query probe logging active connection pool status.
2. **R00.4 (Device Sign-In Telemetry):** Requires physical device video recording or mobile application network logs verifying sign-in on installed APK.
3. **R00.5 (Device Shift Update Telemetry):** Requires physical device video recording or before/after database state logs proving live shift update from APK.
4. **R02.1 (Email/Password Bcrypt Auth):** Requires running `auth.integration.test.ts` against an isolated database to capture test execution output.
5. **R02.2 (Password Visibility Toggle):** Requires automated component/accessibility test output verifying 44×44 touch target and toggle behavior.
6. **R02.4 (Dual-Token Rotation & Revocation):** Requires running `auth.integration.test.ts` to capture token family revocation logs.
7. **R02.5 (SecureStore Persistence):** Requires automated device/emulator test verifying SecureStore token storage across reboots.
8. **R02.6 (Global Logout-All):** Requires running `auth.integration.test.ts` to capture multi-session revocation logs.
9. **R02.8 (Token Lifecycle Suite):** Requires executing `auth.integration.test.ts` and recording test execution logs in evidence docs.
10. **R03.1 (Multi-Tenant Authorization):** Requires running `membership.integration.test.ts` proving 404 anti-enumeration and 403 permission rejections.
11. **R04.1 (Shift Scheduling Operations):** Requires running `shift.integration.test.ts` to capture automated lifecycle test output.
12. **R04.2 (Shift Cancellation Audit Metadata):** Requires running `shift.integration.test.ts` to capture automated cancellation audit logs (`cancelledByUserId`, `cancelledAt`, optimistic concurrency).

---

## 6. Top Blockers & Prioritized Critical Path

To graduate successfully, the remaining gaps must be resolved in the following priority order:

1. **Student Media Artifacts & External Deliverables:**
   - Record the compulsory **3-minute walkthrough video** (R16.1) demonstrating APK install, login with password visibility toggle, team dashboard load, and shift editing.
   - Complete personal written reflections in [LEARNING-LOG.md](../LEARNING-LOG.md) (R14.4).
   - Draft and publish technical LinkedIn post (R16.2), portfolio case study (R16.3, R16.5), and compile the **30-company outreach list** (R16.4).
2. **Missing Compulsory Backend Scalability Workstreams:**
   - **R11.2:** Implement read/write replica database routing with read-your-writes session consistency.
   - **R11.3:** Implement Redis caching layer for team rosters and shift calendars with mutation invalidation.
   - **R12.2:** Build and execute real two-database PostgreSQL sharding simulation script.
3. **Missing Compulsory Mobile & Feature Workstreams:**
   - **R15.1:** Configure and build functional Expo Android development build (`expo-dev-client`).
   - **R04.3 & R04.4:** Staff shift swap request models, routes, and manager approval UI.
   - **R02.3 & R02.7:** Alternative auth (Google OAuth or Magic Link) and self-service password reset.
   - **R03.3 & R03.4:** Team invitation emails/tokens and deep link routing.
   - **R08.1 – R08.7:** Push notifications, token registration, retry worker, and quiet hours delay queuing.
4. **High-Volume Feed & Scalability Proofs:**
   - **R05.1 – R05.7:** Activity feed schema, composite `[timestamp, id]` cursor pagination, 10k seed script, pull-to-refresh UI, and `EXPLAIN ANALYZE` before/after index proof.
   - **R13.2 – R13.4:** `EXPLAIN ANALYZE` query plans and k6 200 VU load test execution.
5. **Client State Modernization:**
   - **R06.1 – R06.5:** Install TanStack Query, define query key factories, implement optimistic updates with automatic rollback, and configure offline cache.
6. **Integration Test Suite Execution (Resolving UNVERIFIED Statuses):**
   - Execute the 10 skipped integration test suites against an isolated staging/test database to certify the 12 UNVERIFIED items as DONE.
