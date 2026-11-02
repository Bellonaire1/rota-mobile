# Rota — Team Shift-Scheduling Mobile Application

> **"Your team, in rhythm"**<br>
> Built for the Dev and Design HQ Product Design and Engineering Bootcamp Final Graduation Task.<br>
> **Repository:** [https://github.com/Bellonaire1/rota-mobile](https://github.com/Bellonaire1/rota-mobile)

---

## 1. Project Overview

**Rota** is a full-stack, mobile-first team shift-scheduling application designed for managers and staff in shift-based small businesses (such as medical clinics, retail stores, and hospitality teams). It replaces fragmented paper rosters, chat groups, and spreadsheets with a single, role-governed operational workspace.

### Core Capabilities & Verified Features

- **Mobile Client (React Native & Expo SDK 57):** Cross-platform mobile client featuring Expo Router file-based navigation, accessible forms with password visibility toggles, and hardware-backed credential storage via `expo-secure-store`.
- **Standalone Android APK Build:** Standalone Android package built using Expo Application Services ([EAS Build `222cb397-2fdb-4286-9b49-009c59a470a8`](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8)), downloaded, installed, and verified on physical Android hardware.
- **Physical Device User Testing:** User sign-in, team dashboard loading, and live shift updates verified from the installed APK against the live cloud backend.
- **Robust Authentication & Session Management:** Dual-token architecture with 15-minute access JWTs and 30-day rotating opaque refresh tokens with automatic token-family reuse detection and cascading revocation.
- **Multi-Tenant Team Architecture & RBAC:** Fine-grained role-based permissions (`OWNER`, `MANAGER`, `STAFF`) strictly scoped per team membership. Adding members, changing member roles, removing members, viewing team billing, and initiating checkout require `MANAGE_TEAM` (**OWNER only**). Creating, updating, and cancelling shifts require `MANAGE_OPERATIONAL_WORK` (**OWNER or MANAGER**). Listing shifts and rosters requires team membership (`requireTeamMembership`). Non-member access returns HTTP 404 to prevent tenant enumeration.
- **Operational Shift Scheduling:** Real-time creation, assignment, date filtering (`YYYY-MM-DD`), editing, and cancellation of shifts with audit metadata (`cancelledByUserId`, `cancelledAt`) and optimistic concurrency checks (`updatedAt`).
- **Live Serverless Deployment:** Backend deployed as an Express.js application on Vercel Fluid compute ([Health Endpoint](https://rota-api-demo.vercel.app/api/v1/health)) connected to Neon Serverless PostgreSQL with connection pooling.

---

## 2. Current Implementation Status & Known Limitations

To maintain strict graduation integrity, the following system limitations and pending items are formally disclosed:

| Subsystem | Status | Implementation Reality & Boundary |
| :--- | :--- | :--- |
| **Mobile App (Android APK)** | **VERIFIED STANDALONE** | Standalone preview APK built via EAS ([Build 222cb397](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8)); authenticated and updated a shift live on physical device. |
| **Expo Dev Client Build** | **OUTSTANDING (PENDING)** | An Expo development build (`expo-dev-client`) is not yet compiled; only the standalone preview APK is currently built. |
| **Backend API** | **LIVE ON VERCEL** | Live on Vercel Serverless ([https://rota-api-demo.vercel.app/api/v1/health](https://rota-api-demo.vercel.app/api/v1/health)), Node.js 22.x runtime. |
| **Health Check Scope** | **PROCESS STATUS ONLY** | `GET /api/v1/health` verifies process uptime and Express routing, but **does not query Neon or verify database connectivity**. |
| **Database & Schema** | **LIVE ON NEON** | PostgreSQL on Neon with pooled connection strings (`DATABASE_URL`); Prisma ORM 6.4.1 targeting `native` & `rhel-openssl-3.0.x`. |
| **Financial / Billing** | **DISABLED (DEMO MODE)** | **`DEMO_MODE=true` is strictly enforced.** Paystack checkout and webhook ingestion return `403 Forbidden`. Payment reconciliation is not certified end-to-end. |
| **Background Webhook Queue** | **PARTIAL (INACTIVE)** | PostgreSQL lease queue exists in code (`server/src/jobs/`), but the worker process is inactive on serverless Vercel. |
| **Redis Caching & Queues** | **NOT IMPLEMENTED** | No Redis instance is provisioned. Shift calendars and rosters query PostgreSQL directly. BullMQ queues are deferred. |
| **Push Notifications** | **NOT IMPLEMENTED** | No push provider (Expo Push / FCM / APNs) is connected. Notification delay queue for quiet hours is unbuilt. |
| **Shift Swaps** | **NOT IMPLEMENTED** | Staff peer-to-peer shift swap requests and manager approval workflows are unbuilt. |
| **Activity Feed & Cursor** | **NOT IMPLEMENTED** | Chronological activity feed, composite `[timestamp, id]` cursor pagination, and 10k seed are unbuilt. |
| **Client State & Offline** | **IN-MEMORY ONLY** | Uses React Context; TanStack Query is not installed. Shifts are held in component memory without offline disk persistence. |
| **Shift Cancellation Reason** | **NOT IN SCHEMA** | Cancellation records actor and timestamp; no cancellation reason field exists in schema or API. |
| **Database Sharding** | **THEORETICAL DESIGN** | Single PostgreSQL instance on Neon. Compulsory two-database sharding simulation script (`R12.2`) is pending. |
| **Test Coverage Scope** | **52 UNIT TESTS PASS** | 52 passing unit tests cover billing math, proration, demo mode, and RBAC. All 9 database integration test suites were skipped during non-destructive testing. |

---

## 3. Technology Stack

### Mobile Application (`/app`)
- **Framework:** React Native 0.86.3 / React 19.2.3
- **Platform:** Expo SDK 57 (~57.0.28), Expo Router v57
- **Security & Storage:** `expo-secure-store` for hardware-backed token persistence
- **UI Architecture:** Custom design system (`BrandHeader`, `ActionButton`, `FormField` with custom accessible vector `EyeIcon`)
- **Compilation & Distribution:** EAS Build (internal preview APK; Build ID `222cb397-2fdb-4286-9b49-009c59a470a8`)

### Backend Service (`/server`)
- **Runtime:** Node.js 22.x (pinned via `engines.node: "22.x"`)
- **Framework:** Express.js 4.21.2
- **Language:** TypeScript 5.7.3 (ES2022 target)
- **ORM:** Prisma Client 6.4.1
- **Database:** Neon Serverless PostgreSQL (PgBouncer connection pooling on AWS `eu-west-2`)
- **Validation:** Zod 3.24.2
- **Cryptography:** bcryptjs 3.0.3, jsonwebtoken 9.0.3, Node.js `crypto` (HMAC-SHA512)
- **Deployment:** Vercel Fluid Compute (`vercel.json` framework: express) / Render fallback (`render.yaml`)

---

## 4. Complete Backend API Route Inventory

The backend exposes 22 endpoints organized across four route modules:

| HTTP Method | Route Path | Purpose | Authentication | Authorization / RBAC |
| :--- | :--- | :--- | :---: | :--- |
| `GET` | `/api/v1/health` | Process health and uptime probe *(does not check DB)* | Public | None |
| `POST` | `/api/v1/auth/register` | Register a new user account with bcrypt password hashing | Public | None |
| `POST` | `/api/v1/auth/login` | Authenticate user; returns access JWT and rotating refresh token | Public | None |
| `POST` | `/api/v1/auth/refresh` | Exchange refresh token for new access JWT and rotated refresh token | Public | None (Token validation in body) |
| `POST` | `/api/v1/auth/logout` | Revoke a single active refresh token session | Public | None (Token validation in body) |
| `POST` | `/api/v1/auth/logout-all` | Globally revoke all active refresh sessions for authenticated user | Required | Authenticated user (`Bearer` JWT) |
| `GET` | `/api/v1/auth/me` | Fetch authenticated user profile details | Required | Authenticated user (`Bearer` JWT) |
| `POST` | `/api/v1/teams` | Create a new team workspace (designates creator as `OWNER`) | Required | Authenticated user (`Bearer` JWT) |
| `GET` | `/api/v1/teams` | List all team workspaces user belongs to | Required | Authenticated user (`Bearer` JWT) |
| `GET` | `/api/v1/teams/:id` | Fetch metadata for a specific team | Required | Authenticated user *(membership-scoped lookup via teamService.getForUser; 404 if non-member)* |
| `GET` | `/api/v1/teams/:teamId/members` | List roster members and their roles for a team | Required | `requireTeamMembership` *(OWNER, MANAGER, STAFF; 404 if non-member)* |
| `POST` | `/api/v1/teams/:teamId/members` | Add an existing registered user to the team roster | Required | `requireTeamPermission(MANAGE_TEAM)` *(OWNER only)* |
| `PATCH` | `/api/v1/teams/:teamId/members/:userId/role` | Update a team member's role (`MANAGER` or `STAFF`) | Required | `requireTeamPermission(MANAGE_TEAM)` *(OWNER only)* |
| `DELETE` | `/api/v1/teams/:teamId/members/:userId` | Remove a member from the team roster | Required | `requireTeamPermission(MANAGE_TEAM)` *(OWNER only)* |
| `GET` | `/api/v1/teams/:teamId/shifts` | Query scheduled shifts with date range and status filters | Required | `requireTeamMembership` *(OWNER, MANAGER, STAFF; 404 if non-member)* |
| `POST` | `/api/v1/teams/:teamId/shifts` | Schedule a new shift for a team member | Required | `requireTeamPermission(MANAGE_OPERATIONAL_WORK)` *(OWNER, MANAGER)* |
| `PATCH` | `/api/v1/teams/:teamId/shifts/:shiftId` | Update shift details, timing, or assignee with optimistic locking | Required | `requireTeamPermission(MANAGE_OPERATIONAL_WORK)` *(OWNER, MANAGER)* |
| `POST` | `/api/v1/teams/:teamId/shifts/:shiftId/cancel` | Cancel a shift with actor/timestamp audit metadata | Required | `requireTeamPermission(MANAGE_OPERATIONAL_WORK)` *(OWNER, MANAGER)* |
| `GET` | `/api/v1/teams/:teamId/billing` | Retrieve subscription plan, seat usage, and billing period | Required | `requireTeamPermission(MANAGE_TEAM)` *(OWNER only)* |
| `POST` | `/api/v1/teams/:teamId/billing/checkout` | Initiate Paystack checkout *(Disabled in DEMO_MODE $\to$ 403)* | Required | `requireTeamPermission(MANAGE_TEAM)` *(OWNER only; blocked by DEMO_MODE for all roles $\to$ 403)* |
| `GET` | `/api/v1/billing/plans` | Public catalog of subscription tiers and minor-unit pricing | Public | None |
| `POST` | `/api/v1/billing/webhooks/paystack` | Ingest Paystack payment webhooks *(Disabled in DEMO_MODE $\to$ 403)* | HMAC-SHA512 | Webhook signature verification over raw body |

---

## 5. Local Development Setup

### Prerequisites
- Node.js `22.x` (LTS recommended)
- npm `10.x` or later
- Expo CLI (`npx expo`) or EAS CLI (`npm i -g eas-cli`)
- Physical Android device with USB debugging enabled OR Android Studio Emulator

---

### Backend Setup (`/server`)

1. Navigate to the server directory:
   ```bash
   cd server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (`server/.env` — copy from `server/.env.example`):
   ```env
   PORT=5000
   NODE_ENV=development
   DATABASE_URL="postgresql://user:password@host/neondb?sslmode=require&pgbouncer=true"
   DIRECT_URL="postgresql://user:password@host/neondb?sslmode=require"
   JWT_ACCESS_SECRET="your-32-char-min-cryptographic-secret"
   ACCESS_TOKEN_TTL_MINUTES=15
   REFRESH_TOKEN_TTL_DAYS=30
   DEMO_MODE=true
   PAYSTACK_MODE=test
   ```
4. Generate the Prisma Client:
   ```bash
   npm run prisma:generate
   ```
5. Start local API server with hot-reload:
   ```bash
   npm run dev
   # API runs at http://localhost:5000/api/v1
   # Health check at http://localhost:5000/api/v1/health
   ```

---

### Mobile App Setup (`/app`)

1. Navigate to the app directory:
   ```bash
   cd app
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure client environment variable (`app/.env` — copy from `app/.env.example`):
   ```env
   # Public backend endpoint URL (no secrets or sensitive keys belong in the mobile client)
   EXPO_PUBLIC_API_URL=https://rota-api-demo.vercel.app/api/v1
   # Or for local development with Android emulator:
   # EXPO_PUBLIC_API_URL=http://10.0.2.2:5000/api/v1
   ```
4. Start the Expo development server:
   ```bash
   npx expo start
   ```
5. Press `a` to open on an Android emulator, or scan the QR code using Expo Go on a physical device.

---

## 6. Verification and Testing

The following practical focused checks validate project consistency:

```bash
# 1. Server TypeScript typecheck (0 errors)
npm --prefix server run typecheck

# 2. Server compilation build
npm --prefix server run build

# 3. Server focused unit tests (52 passing tests across 4 suites)
cd server && npx tsx --test src/billing/demo-mode.test.ts src/rbac/permissions.test.ts src/billing/pricing.test.ts src/billing/billing-calendar.test.ts

# 4. Mobile TypeScript typecheck (0 errors)
cd app && npx tsc --noEmit

# 5. Lockfile clean-install consistency check
npm --prefix server ci --dry-run --ignore-scripts
```

*Note on Integration Tests:* All 10 database integration test suites (`auth.integration.test.ts`, `team.integration.test.ts`, `membership.integration.test.ts`, `shift.integration.test.ts`, `billing.integration.test.ts`, `webhook-worker.integration.test.ts`, `webhook-reconciliation.integration.test.ts`, `subscription-entitlement.integration.test.ts`, `paystack-reconciliation.integration.test.ts`, `provider-plan-reservation.integration.test.ts`) are implemented in `server/src/` but were skipped during non-destructive verification to prevent unintended live database modifications. The reported 52-test unit run did not execute them, and no claim is made that they passed or failed.

---

## 7. Technical Documentation Sitemap

For comprehensive technical specifications, audit tracking, and graduation evidence, refer to:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System components, entity relationships, serverless runtime, and network flow.
- [STATE.md](./STATE.md) — Client session persistence, 401 token refresh interceptors, and database transaction lifecycles.
- [SECURITY.md](./SECURITY.md) — 10-point threat model, token family rotation, fail-closed financial boundaries, and RBAC matrix.
- [SHARDING.md](./SHARDING.md) — Multi-tenant partition key selection, migration roadmap, and sharding simulation status.
- [LEARNING-LOG.md](./LEARNING-LOG.md) — Student reflection template for challenges, trade-offs, and lessons learned.
- [docs/ROTA-COMPLIANCE-TRACKER.md](./docs/ROTA-COMPLIANCE-TRACKER.md) — Master 100-item graduation compliance tracker.
- [docs/ROTA-SUBMISSION-EVIDENCE.md](./docs/ROTA-SUBMISSION-EVIDENCE.md) — Verified graduation submission links, test proofs, and outstanding deliverables.

### Demonstration Media Status
- **Android APK Build:** [Verified EAS Preview Build Artifact](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8)
- **Live Deployed API:** [https://rota-api-demo.vercel.app/api/v1/health](https://rota-api-demo.vercel.app/api/v1/health)
- **3-Minute Demonstration Video:** **Pending Student Recording** (Walkthrough showing APK installation, login with password toggle, team dashboard load, and shift update on physical Android hardware).
