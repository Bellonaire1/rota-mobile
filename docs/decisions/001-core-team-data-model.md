# ADR 001: Core Team Data Model and RBAC

## Decision

- `User`, `Team`, and `TeamMembership` are separate because identity, team ownership, and a user's team-scoped membership are different concerns. This supports one user belonging to multiple teams without duplicating identity data.
- `TeamMembership` has a unique `[teamId, userId]` pair so a user can have at most one membership and role per team.
- `TeamRole` belongs on `TeamMembership`, not `User`, because authority is scoped to a team. The same user may be an owner, manager, or staff member in different teams.
- `Team.createdByUserId` uses `Restrict` deletion to prevent deleting the user who is recorded as the team's creator while the team still exists.
- Membership relations use `Cascade` when a `User` or `Team` is deleted because memberships have no independent meaning after either parent is removed.

RBAC uses a centralized `Permission` enum, an explicit role-to-permission matrix, and `hasPermission(role, permission)`. No authentication context or middleware is part of this foundation.

## Deferred

Authentication, JWTs, refresh tokens, invites, password reset, shifts, subscriptions, payments, and notifications are intentionally deferred.
