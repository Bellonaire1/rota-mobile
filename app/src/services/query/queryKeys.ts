import { ShiftListParams } from '@/services/api/shiftService';
import { ShiftSwapListParams } from '@/services/api/shiftSwapService';
import { ActivityFeedQuery } from '@/types/api';

/**
 * Structured, type-safe hierarchical query key factories.
 *
 * Follows TanStack Query best practices for multi-tenant scoping:
 * Root domain -> Tenant/Scope identifiers (teamId, userId) -> Operation -> Filter/Parameters
 *
 * This ensures:
 * 1. Targeted invalidation: Invalidate `shifts.all(teamId, userId)` invalidates ALL lists,
 *    infinite queries, details, and paginated queries for that specific team and user.
 * 2. Cross-team isolation: Team A queries are strictly partitioned from Team B.
 * 3. Cross-user isolation: User A cache entries are never returned for User B.
 * 4. Deterministic prefix matching by TanStack Query query filters.
 */
export const queryKeys = {
  /**
   * Teams namespace
   */
  teams: {
    all: (userId: string) => ['teams', userId] as const,
    list: (userId: string) => ['teams', userId, 'list'] as const,
    detail: (userId: string, teamId: string) => ['teams', userId, 'detail', teamId] as const,
  },

  /**
   * Team members and invitations namespace
   */
  members: {
    all: (teamId: string, userId: string) => ['members', teamId, userId] as const,
    infinite: (teamId: string, userId: string, params?: { limit?: number }) =>
      ['members', teamId, userId, 'infinite', params ?? {}] as const,
    list: (teamId: string, userId: string, params?: { page?: number; limit?: number }) =>
      ['members', teamId, userId, 'list', params ?? {}] as const,
    allList: (teamId: string, userId: string) =>
      ['members', teamId, userId, 'allList'] as const,
    invitations: (teamId: string, userId: string) =>
      ['members', teamId, userId, 'invitations'] as const,
  },

  /**
   * Shifts namespace
   */
  shifts: {
    all: (teamId: string, userId: string) => ['shifts', teamId, userId] as const,
    infinite: (teamId: string, userId: string, params?: Omit<ShiftListParams, 'page'>) =>
      ['shifts', teamId, userId, 'infinite', params ?? {}] as const,
    list: (teamId: string, userId: string, params?: ShiftListParams) =>
      ['shifts', teamId, userId, 'list', params ?? {}] as const,
    detail: (teamId: string, shiftId: string, userId: string) =>
      ['shifts', teamId, userId, 'detail', shiftId] as const,
  },

  /**
   * Shift swaps namespace
   */
  shiftSwaps: {
    all: (teamId: string, userId: string) => ['shiftSwaps', teamId, userId] as const,
    list: (teamId: string, userId: string, params?: ShiftSwapListParams) =>
      ['shiftSwaps', teamId, userId, 'list', params ?? {}] as const,
    pendingCounts: (teamId: string, userId: string) =>
      ['shiftSwaps', teamId, userId, 'pendingCounts'] as const,
  },

  /**
   * Team activity feed namespace
   */
  activity: {
    all: (teamId: string, userId: string) => ['activity', teamId, userId] as const,
    feed: (teamId: string, userId: string, query?: ActivityFeedQuery) =>
      ['activity', teamId, userId, 'feed', query ?? {}] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
