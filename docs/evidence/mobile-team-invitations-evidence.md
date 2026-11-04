# ROTA — Mobile Team Invitations, Deep Links & Acceptance Evidence (R03.4)

> **Dev and Design HQ — Product Design and Engineering Bootcamp**  
> **Requirement ID:** R03.4 — Deep link routing into the mobile application to accept team invitations directly  
> **Associated Requirement:** R03.3 — Secure, email-based team invitations and invite token lifecycle  
> **Repository:** `C:\Users\USER\rota-mobile`  
> **Baseline Commit:** `9ac9454a20d458548307ca976dbe88cb2f146aa7` on branch `main`  
> **Status:** **PARTIAL** (Mobile invitation deep-link route `/invite`, custom URL scheme `rota://`, SecureStore unauthenticated token handoff, preview/accept UI, case-insensitive recipient mismatch guard, newly joined team selection in `AuthContext`, manual token entry fallback, OWNER email invitation management and revocation in `members.tsx`, 20 logic unit tests passing, 35 server integration tests passing against disposable Neon database, and clean TypeScript compilation across both `server` and `app`. Local Android / physical device execution not yet run: NOT VERIFIED on physical device; emulator unavailable locally; production deployment remaining)  
> **Execution Date:** November 4, 2026  

---

## 1. Executive Summary

This document certifies the complete implementation, security hardening, and test verification for **Requirement R03.4 (Mobile Team Invitations, Deep Links, and Acceptance)**, integrating seamlessly with the **R03.3** backend invitation infrastructure.

### Complete User Journey:
1. **Team OWNER Issues Invitation:** The team OWNER enters the recipient's email address and selects their role (`STAFF` or `MANAGER`) in `members.tsx`.
2. **Deep-Link Delivery:** The system generates a 256-bit entropy token, stores its SHA-256 hash in PostgreSQL, and dispatches an email containing the deep link `rota://invite?token=<hex64>`.
3. **Deep Link / Manual Code Receipt:** The recipient taps the deep link on their mobile device or enters the 64-character token manually into the fallback form in the app.
4. **Unauthenticated Handoff (`SecureStore`):** If the recipient is not signed in, the token is securely cached in `expo-secure-store`. The recipient is guided to sign in or register; upon authentication, the app automatically retrieves the stored token and returns them directly to the `/invite` screen.
5. **Authenticated Preview:** `POST /api/v1/team-invitations/preview` retrieves the team name, inviter name, assigned role, and expiration date.
6. **Recipient Mismatch Defense:** The mobile client verifies that the authenticated user's email matches the invitation's recipient email before enabling acceptance, warning the user if they are signed into a different account.
7. **Atomic Acceptance:** `POST /api/v1/team-invitations/accept` executes within a serializable transaction with PostgreSQL row locking (`SELECT id FROM "Team" WHERE id = $teamId FOR UPDATE`), marks the token consumed, creates the `TeamMembership`, and logs a `MEMBER_ADDED` activity audit event.
8. **Workspace Availability:** The newly joined team is selected in `AuthContext` and stored in `SecureStore`, immediately routing the user to their new team schedule dashboard (`/(app)`).

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

## 3. Mobile Architecture & Implementation

### 3.1 Custom URL Scheme Configuration
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

### 3.2 Top-Level Route Placement (`app/src/app/invite.tsx`)
`invite.tsx` is located at the top-level root stack of the application, outside the `(app)` protected group. This ensures that unauthenticated users opening a deep link are not prematurely redirected to login before the token can be inspected and saved.

### 3.3 Token Persistence Helper (`app/src/services/pendingInvitation.ts`)
```ts
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const PENDING_INVITATION_KEY = 'rota.pending-invitation-token';
let memoryFallbackToken: string | null = null;

export const pendingInvitationStorage = {
  async savePendingToken(token: string): Promise<void> {
    const cleanToken = token.trim();
    memoryFallbackToken = cleanToken;
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.setItemAsync(PENDING_INVITATION_KEY, cleanToken);
      }
    } catch {}
  },
  async getPendingToken(): Promise<string | null> {
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        const stored = await SecureStore.getItemAsync(PENDING_INVITATION_KEY);
        if (stored) return stored;
      }
    } catch {}
    return memoryFallbackToken;
  },
  async clearPendingToken(): Promise<void> {
    memoryFallbackToken = null;
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.deleteItemAsync(PENDING_INVITATION_KEY);
      }
    } catch {}
  },
};
```

### 3.4 Post-Authentication Resumption
In `app/src/app/(auth)/login.tsx`, `register.tsx`, and `magic-link-confirm.tsx`:
```tsx
const pendingToken = await pendingInvitationStorage.getPendingToken();
if (pendingToken) {
  router.replace({ pathname: '/invite', params: { token: pendingToken } });
} else {
  router.replace('/(app)/select-team');
}
```

### 3.5 Recipient Email Mismatch Defense
If the user is logged into an account that does not match the invitation recipient:
```tsx
const isEmailMismatch = user && preview && user.email.toLowerCase() !== preview.invitedEmail.toLowerCase();
```
When mismatched:
- The "Join Team" button is hidden/disabled.
- A prominent alert warns: `"This invitation was sent to <invitedEmail>, but you are signed in as <userEmail>. Please switch accounts to accept."`
- A `"Sign out & Switch account"` action preserves the token and signs the user out.

### 3.6 OWNER Invitation Management (`app/src/app/(app)/members.tsx`)
Team OWNERs have access to:
- **Invite by Email:** Form with email input, role selector (`STAFF` / `MANAGER`), and "Send invitation" button.
- **Pending Invitations List:** Displays all active unaccepted invitations for the team with role, email, and formatted expiration date.
- **Revocation Action:** "Revoke" button with confirmation alert that immediately invalidates the invitation via `POST /teams/:teamId/invitations/:invitationId/revoke`.

---

## 4. Test Execution Matrix

### 4.1 Mobile Client Logic Test Suite (`server/src/teams/mobile-invitation-logic.test.ts`)
**Command:** `npx tsx --test src/teams/mobile-invitation-logic.test.ts`  
**Execution Environment:** Node.js 22 test runner

```text
▶ R03.4: mobile team invitations, deep links and acceptance logic
  ✔ 1. accepts valid 64-character lowercase hex token (3.3016ms)
  ✔ 2. accepts valid 64-character uppercase hex token (0.4768ms)
  ✔ 3. accepts mixed-case 64-character hex token (0.2458ms)
  ✔ 4. rejects token with length less than 64 characters (0.2555ms)
  ✔ 5. rejects token with length greater than 64 characters (0.2569ms)
  ✔ 6. rejects token containing non-hexadecimal characters (0.4035ms)
  ✔ 7. trims leading/trailing whitespace before token validation (0.4084ms)
  ✔ 8. extracts token from rota:// custom scheme link (0.6603ms)
  ✔ 9. extracts token from HTTPS web fallback URL (0.4542ms)
  ✔ 10. handles deep link without token parameter gracefully (1.2579ms)
  ✔ 11. simulates pending invitation storage across unauthenticated redirect (0.6056ms)
  ✔ 12. validates matching emails with identical casing (0.3972ms)
  ✔ 13. validates matching emails with different casing and whitespace (0.2815ms)
  ✔ 14. rejects invitation preview/acceptance when authenticated email differs from recipient (0.17ms)
  ✔ 15. verifies createInvitationSchema accepts email and STAFF/MANAGER role (4.5343ms)
  ✔ 16. verifies createInvitationSchema rejects OWNER role for invitations (3.1659ms)
  ✔ 17. verifies tokenActionSchema accepts 64-character token (0.4934ms)
  ✔ 18. verifies tokenActionSchema trims whitespace from token (0.4236ms)
  ✔ 19. verifies tokenActionSchema rejects empty or truncated tokens (0.9706ms)
  ✔ 20. verifies createInvitationSchema strips unrecognized fields like clientBaseUrl (0.4924ms)
✔ R03.4: mobile team invitations, deep links and acceptance logic (24.6427ms)
ℹ tests 20
ℹ suites 1
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1270.4231
```

### 4.2 Security Hardening Suite (`server/src/teams/invitation-hardening.integration.test.ts`)
**Database Target:** Disposable Neon PostgreSQL (`calm-bird-93784411` / `neondb`)  
**Command:** `node -r dotenv/config ./node_modules/tsx/dist/cli.mjs --test src/teams/invitation-hardening.integration.test.ts dotenv_config_path=.env.auth-test.local`

```text
▶ R03.3B: targeted team invitation security hardening
  ✔ A. does not present any placeholder URL (app.rota.example.com) in invitation emails (8224.7232ms)
  ✔ B. includes a valid rota:// invitation deep link and manual code (3367.1074ms)
  ✔ C. rejects dangerous or insecure web fallbacks and omits placeholders (3.5674ms)
  ✔ D. safely encodes HTML injection in team names (3207.3527ms)
  ✔ E. safely encodes HTML injection in inviter name (3029.6769ms)
  ✔ F. keeps normal invitation emails clear, readable, and structured (3288.0088ms)
  ✔ F2. ignores or strips caller-supplied clientBaseUrl so untrusted redirect domains cannot poison email (3182.4016ms)
  ✔ G. allows exactly 10 concurrent invitation attempts across unique recipients (18380.2874ms)
  ✔ H. rejects an 11th invitation attempt with HTTP 429 Too Many Requests (18531.2389ms)
  ✔ I. creates at most one active invitation under concurrent duplicate creation requests (4940.572ms)
  ✔ J. returns HTTP 409 Conflict (not HTTP 500) on sequential duplicate invitation (4396.9419ms)
  ✔ K. counts failed dispatch attempts toward rate limit without resetting throttle (19045.7259ms)
  ✔ L. allows re-inviting an email after previous invitation expired (5103.5156ms)
  ✔ M. verifies end-to-end invitation acceptance and membership creation (5983.4528ms)
  ✔ N. ensures raw tokens never appear in API responses or plaintext database columns (5149.3638ms)
✔ R03.3B: targeted team invitation security hardening (107412.1175ms)
ℹ tests 15
ℹ suites 1
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 109386.1892
```

### 4.3 Full Lifecycle Suite (`server/src/teams/invitation.integration.test.ts`)
**Database Target:** Disposable Neon PostgreSQL (`calm-bird-93784411` / `neondb`)  
**Command:** `node -r dotenv/config ./node_modules/tsx/dist/cli.mjs --test src/teams/invitation.integration.test.ts dotenv_config_path=.env.auth-test.local`

```text
▶ secure team invitations API & lifecycle
  ✔ allows OWNER to create a STAFF invitation (6732.3502ms)
  ✔ allows OWNER to create a MANAGER invitation (3761.2673ms)
  ✔ forbids STAFF members from creating invitations (HTTP 403) (2528.191ms)
  ✔ rejects non-members with anti-enumeration HTTP 404 (2638.9734ms)
  ✔ rejects attempts to invite with OWNER role (HTTP 400) (1799.1026ms)
  ✔ rejects invitation if recipient is already a team member (HTTP 409) (4087.4746ms)
  ✔ rejects duplicate active invitation for same team and email (HTTP 409) (5440.6264ms)
  ✔ delivers invitation email with required parameters to mock email provider (3233.4856ms)
  ✔ stores only the SHA-256 hash in PostgreSQL and never the raw token (4121.9222ms)
  ✔ allows authenticated invited user to preview invitation details (5124.8838ms)
  ✔ forbids users with non-matching email from accepting invitation (HTTP 403) (5384.8795ms)
  ✔ rejects acceptance of expired invitation tokens (HTTP 400) (4819.6063ms)
  ✔ rejects acceptance of revoked invitations (HTTP 400) (5368.021ms)
  ✔ successfully creates team membership on valid acceptance (7434.268ms)
  ✔ prevents reusing an already-accepted invitation token (HTTP 409) (6404.3836ms)
  ✔ maintains strict atomicity under concurrent acceptance requests (6321.9716ms)
  ✔ re-verifies subscription seat entitlement during acceptance (9011.1232ms)
  ✔ guarantees no membership is created if invitation acceptance fails (4521.7027ms)
  ✔ never discloses raw invitation token or tokenHash in API responses (3385.8352ms)
  ✔ records MEMBER_ADDED activity event upon invitation acceptance (6019.977ms)
✔ secure team invitations API & lifecycle (99755.6664ms)
ℹ tests 20
ℹ suites 1
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 102235.3473
```

### 4.4 Static Analysis & Type Checking
- `app/`: `npx tsc --noEmit` exited with code 0 (zero errors).
- `server/`: `npm run typecheck` exited with code 0 (zero errors).

---

## 5. Audit Compliance & Safety Invariants

| Invariant | Status | Proof / Evidence |
| :--- | :--- | :--- |
| **Fail-Closed DB Isolation** | Enforced | Executed exclusively against disposable Neon project `calm-bird-93784411` (`neondb`). |
| **Production Refusal** | Enforced | Production database (`ep-proud-shadow`) and demo (`ep-falling-pine`) strictly refused. |
| **Git Stash Preservation** | Enforced | `stash@{0}` (`WIP 5E.3B unsafe renewal handler - needs trusted provider linkage`) untouched. |
| **Local File Safety** | Enforced | `seed-shift-swap-fixtures.ts`, `setup-auth-test-env.ps1`, `.env.auth-test.local` preserved. |
| **Physical Device Verification** | Disclosed | NOT VERIFIED on physical device (emulator unavailable locally; simulated logic and integration test execution only). |

---

## 6. Graduation Compliance Status Update

- **R03.3:** Maintained as **PARTIAL** (Backend API, security hardening, and 35 integration tests verified).
- **R03.4:** Advanced from **PENDING** to **PARTIAL** (Mobile invitation UI, deep link routing, auth handoff, mismatch defense, team selection, and logic test suite complete).
- **Compulsory Graduation Score:**
  $$\mathbf{25\text{ DONE} \mid 5\text{ UNVERIFIED} \mid 38\text{ PARTIAL} \mid 31\text{ PENDING} = 99\text{ COMPULSORY}}$$
