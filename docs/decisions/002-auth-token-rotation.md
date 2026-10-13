# ADR 002: Authentication Token Rotation

## Decision

- Access tokens are short-lived (15 minutes by default) to limit the impact of a stolen bearer token.
- Refresh tokens are opaque random values rather than JWTs, so their server-side lifecycle can be controlled and revoked.
- PostgreSQL stores only a SHA-256 hash of each refresh token; raw refresh values are returned once and never persisted.
- Each refresh session has a `familyId`. A successful refresh marks the presented token used and creates a replacement in the same family within a serializable transaction.
- Reuse of a used or revoked refresh token revokes every token in that family. Expired and revoked tokens are rejected.
- Logout revokes the presented token family. Logout-all revokes every active session for the authenticated user.
- Authentication establishes identity only. Team membership and permission checks remain separate in the existing RBAC foundation and are intentionally not inferred by auth middleware.
- `AuthSession.userId` cascades on user deletion because sessions have no meaning without their user.

## Deferred

Google OAuth, magic links, password reset, team invitations, shifts, subscriptions, payments, Redis, queues, notifications, and mobile authentication screens remain deferred.
