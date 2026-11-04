# ROTA — Mobile Team Invitations, Deep Links & Acceptance Evidence (R03.4 & R03.4B)

> **Dev and Design HQ — Product Design and Engineering Bootcamp**  
> **Requirement ID:** R03.4 — Deep link routing into the mobile application to accept team invitations directly  
> **Associated Requirement:** R03.3 — Secure, email-based team invitations and invite token lifecycle  
> **Repository:** `C:\Users\USER\rota-mobile`  
> **Baseline Commit:** `c9c964d1b67e75da86de23f53c9f34c80f6f7828` on branch `main`  
> **Status:** **PARTIAL** (Mobile invitation deep-link route `/invite`, custom URL scheme `rota://`, SecureStore unauthenticated token handoff, preview/accept UI, case-insensitive recipient mismatch guard, real server-returned team selection in `AuthContext` with zero fabrication, request-generation preview invalidation, manual token entry fallback, OWNER email invitation management and revocation in `members.tsx`, 30 logic and correctness tests passing, 35 server integration tests passing against disposable Neon database, and clean TypeScript compilation across both `server` and `app`. Local Android / physical device execution not yet run: NOT VERIFIED on physical device; emulator unavailable locally; production deployment remaining)  
> **Execution Date:** November 4, 2026  

---

## 1. Executive Summary

This document certifies the complete implementation, security hardening, and test verification for **Requirement R03.4 (Mobile Team Invitations, Deep Links, and Acceptance)** and its subsequent stabilization under **Task R03.4B**, integrating seamlessly with the **R03.3** backend invitation infrastructure.

### Complete User Journey:
1. **Team OWNER Issues Invitation:** The team OWNER enters the recipient's email address and selects their role (`STAFF` or `MANAGER`) in `members.tsx`.
2. **Deep-Link Delivery:** The system generates a 256-bit entropy token, stores its SHA-256 hash in PostgreSQL, and dispatches an email containing the deep link `rota://invite?token=<hex64>`.
3. **Deep Link / Manual Code Receipt:** The recipient taps the deep link on their mobile device or enters the 64-character token manually into the fallback form in the app.
4. **Unauthenticated Handoff (`SecureStore`):** If the recipient is not signed in, the token is securely cached in `expo-secure-store`. The recipient is guided to sign in or register; upon authentication, the app automatically retrieves the stored token and returns them directly to the `/invite` screen.
5. **Authenticated Preview with Generation Check:** `POST /api/v1/team-invitations/preview` retrieves the team name, inviter name, assigned role, and expiration date. Responses from previous tokens or prior account sessions are strictly discarded using monotonic generation counters.
6. **Recipient Mismatch Defense:** The mobile client verifies that the authenticated user's email matches the invitation's recipient email before enabling acceptance, warning the user if they are signed into a different account.
7. **Atomic Acceptance with Submission Lock:** `POST /api/v1/team-invitations/accept` executes within a serializable transaction with PostgreSQL row locking (`SELECT id FROM "Team" WHERE id = $teamId FOR UPDATE`), marks the token consumed, creates the `TeamMembership`, and logs a `MEMBER_ADDED` activity audit event. Parallel submissions are locked out via an immediate synchronous ref lock.
8. **Real Server-Returned Workspace Availability (Zero Fabrication):** The newly joined team is validated against the refreshed team roster from the server, selected in `AuthContext`, and stored in `SecureStore`, immediately routing the user to their new team schedule dashboard (`/(app)`). If team list synchronization fails, no fake fallback team is fabricated; instead, an explicit retry synchronization state is presented without repeating the consumed accept API call.

---

## 2. Phase 0 — Mandatory Backend Security Correction

Prior to mobile integration, a vulnerability in the invitation creation API was eliminated:

### Vulnerability Identified:
- `POST /api/v1/teams/:teamId/invitations` accepted an optional `clientBaseUrl` parameter from callers.
- A malicious actor could supply an untrusted domain (e.g. `https://attacker-phishing.com`), which the email service would inject into the invitation email, creating an open redirect / token exfiltration vector.

### Correction Implemented:
1. **Schema Stripping (`server/src/schemas/team-invitation.schema.ts`):** `clientBaseUrl` was completely removed from `createInvitationSchema`.
2. **Service Isolation (`server/src/services/team-invitation.service.ts`):** `teamInvitationService.create` no longer passes `clientBaseUrl` from input payloads.
3. **Server-Configured Base URL Only (`server/src/services/email/email.service.ts`):** Fallback web links are derived strictly from `process.env.APP_BASE_URL` (server-configured only) after protocol validation (`resolveTrustedWebUrl`).
4. **Automated Regression Test (`invitation-hardening.integration.test.ts`):** Test `F2` asserts that caller-supplied `clientBaseUrl` values are ignored and never appear in email text or HTML bodies.

---

## 3. Task R03.4B Correctness & Stabilization Fixes

Three critical edge cases were identified and stabilized:

### 3.1 Pending Invitation Lifecycle Fixes
- **Confirmed Defect:** Abandoned invitations ("Enter a different code", "Dismiss", or back navigation) failed to consistently clear the token from SecureStore, causing subsequent unrelated logins to be hijacked and redirected to `/invite`.
- **Corrections:**
  - `handleEnterDifferentCode()`, `handleDismiss()`, `handleBackToTeams()`, and `handleBackToSignIn()` explicitly call `await pendingInvitationStorage.cancelInvitation()` to purge the token.
  - New valid tokens parsed or entered intentionally overwrite older stored tokens.
  - Switching accounts explicitly calls `pendingInvitationStorage.switchAccount(token)` before sign-out to preserve the token specifically for the intended account switch.
  - Normal sign-out does not clear switch-account tokens, but abandoned tokens are prevented from redirecting unrelated logins via explicit cancellation and a 24-hour maximum handoff TTL (`DEFAULT_PENDING_TOKEN_MAX_AGE_MS`).
  - Pre-navigation awaiting in `handleNavigateToAuth()` eliminates asynchronous write-versus-navigation races.

### 3.2 Acceptance Success Handling (Zero Fabrication)
- **Confirmed Defect:** If `teamService.list()` failed following successful invitation acceptance, the app fabricated a client-side `Team` object with blank IDs/metadata (`createdByUserId: ''`) and local timestamps.
- **Corrections:**
  - Removed all fabricated fallback object creation.
  - Immediate synchronous lock (`InvitationAcceptanceCoordinator.acceptAndSync`) rejects rapid duplicate button taps.
  - Validates that the newly accepted team exists in the server-returned team roster from `teamService.list()` before calling `selectTeam()`.
  - If team synchronization fails post-acceptance, the coordinator preserves `acceptedTeamId`, marks `syncFailed: true`, and presents an explicit `"Team synchronization needed"` screen with a `"Retry team sync"` action that only refreshes the team list without repeating the already-consumed `accept` call.

### 3.3 Stale Preview Responses (Request-Generation Tracking)
- **Confirmed Defect:** `fetchPreview()` failed to reject outdated responses when the active token or user account changed while a network request was in-flight.
- **Corrections:**
  - Implemented `PreviewGenerationTracker`: every preview request increments a monotonic generation counter and records `currentToken` and `currentUserId`.
  - Responses resolving out-of-order or after token/user changes are discarded immediately before setting state.
  - Switching tokens or switching accounts immediately purges the active preview state, preventing stale team information exposure.

---

## 4. Mobile Architecture & Implementation

### 4.1 Custom URL Scheme Configuration
In `app/app.json`:
```json
{
  "expo": {
    "name": "Rota",
    "scheme": "rota",
    "plugins": ["expo-router", "expo-secure-store"],
    "experiments": {
      "typedRoutes": true
    }
  }
}
```
Expo Router automatically routes `rota://invite?token=<hex64>` to the `/invite` route.

### 4.2 Top-Level Route Placement (`app/src/app/invite.tsx`)
`invite.tsx` is located at the top-level root stack of the application, outside the `(app)` protected group. This ensures that unauthenticated users opening a deep link are not prematurely redirected to login before the token can be inspected and saved.

### 4.3 Extracted Workflow Coordinators (`app/src/services/invitationWorkflow.ts`)
The workflow logic is partitioned into clean, highly-testable coordinators:
- `PendingTokenManager`: Pluggable storage manager with explicit cancellation and abandonment expiration.
- `PreviewGenerationTracker`: Monotonic request generation counter guarding against stale out-of-order network responses.
- `InvitationAcceptanceCoordinator`: State machine ensuring submission locks, real server team selection, and retry without double-acceptance.

---

## 5. Test Execution Matrix

### 5.1 Mobile Client Logic & Correctness Test Suite (`server/src/teams/mobile-invitation-logic.test.ts`)
**Command:** `npx tsx --test src/teams/mobile-invitation-logic.test.ts`  
**Execution Environment:** Node.js 22 test runner

```text
▶ R03.4 & R03.4B: mobile team invitations, deep links and acceptance workflow
  ✔ 1. accepts valid 64-character lowercase hex token (3.0038ms)
  ✔ 2. accepts valid 64-character uppercase hex token (0.3791ms)
  ✔ 3. accepts mixed-case 64-character hex token (0.2177ms)
  ✔ 4. rejects token with length less than 64 characters (0.2466ms)
  ✔ 5. rejects token with length greater than 64 characters (0.2417ms)
  ✔ 6. rejects token containing non-hexadecimal characters (0.2585ms)
  ✔ 7. trims leading/trailing whitespace before token validation (0.2092ms)
  ✔ 8. extracts token from rota:// custom scheme link (0.45ms)
  ✔ 9. extracts token from HTTPS web fallback URL (0.3832ms)
  ✔ 10. handles deep link without token parameter gracefully (0.4636ms)
  ✔ 11. validates matching emails with identical casing (0.2411ms)
  ✔ 12. validates matching emails with different casing and whitespace (0.1949ms)
  ✔ 13. rejects invitation preview/acceptance when authenticated email differs from recipient (0.161ms)
  ✔ 14. verifies createInvitationSchema accepts email and STAFF/MANAGER role (4.1782ms)
  ✔ 15. verifies createInvitationSchema rejects OWNER role for invitations (1.4586ms)
  ✔ 16. verifies tokenActionSchema accepts 64-character token (0.3555ms)
  ✔ 17. verifies tokenActionSchema trims whitespace from token (0.2545ms)
  ✔ 18. verifies tokenActionSchema rejects empty or truncated tokens (0.5994ms)
  ✔ 19. verifies createInvitationSchema strips unrecognized fields like clientBaseUrl (3.1644ms)
  ✔ A. cancel invitation clears persisted token from storage and memory (1.1434ms)
  ✔ B. switching accounts preserves the intended invitation token (0.2418ms)
  ✔ C. new invitation replaces an old pending token in storage (0.1845ms)
  ✔ D. unrelated login is not redirected by an abandoned/expired token (70.0298ms)
  ✔ E. token A response cannot overwrite token B preview when token changes (0.771ms)
  ✔ F. previous-account preview cannot overwrite current-account state (0.2309ms)
  ✔ G. accepted invitation does not trigger duplicate acceptance API calls (1.8823ms)
  ✔ H. failed post-accept team refresh does not fabricate a team object (0.9257ms)
  ✔ I. team-list retry can recover after acceptance without re-calling accept (0.5666ms)
  ✔ J. successful team refresh selects the real server team and completes navigation (0.4079ms)
  ✔ K. rapid duplicate button taps cannot create parallel acceptance calls (42.2447ms)
✔ R03.4 & R03.4B: mobile team invitations, deep links and acceptance workflow (138.9542ms)
ℹ tests 30
ℹ suites 1
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1201.5473
```

### 5.2 Backend Security Hardening Suite (`server/src/teams/invitation-hardening.integration.test.ts`)
**Database Target:** Disposable Neon PostgreSQL (`calm-bird-93784411` / `neondb`)  
**Results:** 15/15 PASS (including Test `F2` verifying clientBaseUrl stripping).

### 5.3 Full Invitation Lifecycle Integration Suite (`server/src/teams/invitation.integration.test.ts`)
**Database Target:** Disposable Neon PostgreSQL (`calm-bird-93784411` / `neondb`)  
**Results:** 20/20 PASS.

### 5.4 Static Analysis & Type Checking
- `app/`: `npx tsc --noEmit` passed with 0 errors.
- `server/`: `npm run typecheck` passed with 0 errors.

---

## 6. Audit Compliance & Known Physical Device Limitations

| Invariant | Status | Proof / Evidence |
| :--- | :--- | :--- |
| **Fail-Closed DB Isolation** | Enforced | Executed exclusively against disposable Neon project `calm-bird-93784411` (`neondb`). |
| **Production Refusal** | Enforced | Production database (`ep-proud-shadow`) and demo (`ep-falling-pine`) strictly refused. |
| **Git Stash Preservation** | Enforced | `stash@{0}` (`WIP 5E.3B unsafe renewal handler - needs trusted provider linkage`) untouched. |
| **Local File Safety** | Enforced | `seed-shift-swap-fixtures.ts`, `setup-auth-test-env.ps1`, `.env.auth-test.local` preserved. |
| **Physical Device Verification** | Disclosed | NOT VERIFIED on physical device (emulator unavailable locally; simulated logic and integration test execution only). Production deployment to Vercel and standalone APK build remaining. |

---

## 7. Graduation Compliance Status Update

- **R03.3:** Maintained as **PARTIAL** (Backend API, security hardening, and 35 integration tests verified).
- **R03.4:** Maintained as **PARTIAL** (Mobile invitation UI, deep link routing, auth handoff, mismatch defense, real server team selection, and 30 passing logic and correctness tests).
- **Compulsory Graduation Score:**
  $$\mathbf{25\text{ DONE} \mid 5\text{ UNVERIFIED} \mid 38\text{ PARTIAL} \mid 31\text{ PENDING} = 99\text{ COMPULSORY}}$$
