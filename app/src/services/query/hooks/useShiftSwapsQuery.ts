import { useQuery } from '@tanstack/react-query';
import { shiftSwapService } from '@/services/api/shiftSwapService';
import { teamService } from '@/services/api/teamService';
import { queryKeys } from '../queryKeys';
import { Pagination, ShiftSwap, TeamRole } from '@/types/api';

export type TabType = 'INCOMING' | 'MY_REQUESTS' | 'MANAGER_REVIEW' | 'HISTORY';
export type HistoryFilter = 'ALL' | 'APPROVED' | 'REJECTED' | 'DECLINED' | 'CANCELLED';

export interface ShiftSwapsTabResult {
  shiftSwaps: ShiftSwap[];
  pagination: Pagination;
}

export interface ShiftSwapTabCounts {
  incoming: number;
  myRequests: number;
  managerReview: number;
}

/**
 * Loads paginated shift swaps partitioned by active tab and history filter.
 * Kept in TanStack Query cache to enable instant optimistic UI mutations.
 */
export function useShiftSwapsTab(
  teamId?: string,
  userId?: string,
  activeTab: TabType = 'INCOMING',
  historyFilter: HistoryFilter = 'ALL',
  page: number = 1
) {
  return useQuery<ShiftSwapsTabResult, Error>({
    queryKey: queryKeys.shiftSwaps.tab(teamId ?? '', userId ?? '', activeTab, historyFilter, page),
    queryFn: async (): Promise<ShiftSwapsTabResult> => {
      if (!teamId || !userId) {
        return { shiftSwaps: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 1 } };
      }

      if (activeTab === 'MANAGER_REVIEW') {
        const response = await shiftSwapService.list(teamId, {
          page,
          limit: 20,
          status: 'PENDING_MANAGER',
        });
        return {
          shiftSwaps: response.shiftSwaps,
          pagination: response.pagination,
        };
      }

      if (activeTab === 'INCOMING') {
        const response = await shiftSwapService.list(teamId, {
          page,
          limit: 30,
          status: 'PENDING_PEER',
        });
        const incomingOnly = response.shiftSwaps.filter((s) => s.receivingUserId === userId);
        return {
          shiftSwaps: incomingOnly,
          pagination: response.pagination,
        };
      }

      if (activeTab === 'MY_REQUESTS') {
        const [peerRes, mgrRes] = await Promise.all([
          shiftSwapService.list(teamId, { page, limit: 30, status: 'PENDING_PEER' }),
          shiftSwapService.list(teamId, { page, limit: 30, status: 'PENDING_MANAGER' }),
        ]);
        const myActive = [...peerRes.shiftSwaps, ...mgrRes.shiftSwaps].filter(
          (s) => s.requestingUserId === userId
        );
        const maxTotalPages = Math.max(peerRes.pagination.totalPages, mgrRes.pagination.totalPages);
        const combinedTotal = peerRes.pagination.total + mgrRes.pagination.total;
        return {
          shiftSwaps: myActive,
          pagination: {
            page,
            limit: 30,
            total: combinedTotal,
            totalPages: maxTotalPages,
          },
        };
      }

      // HISTORY tab
      const statusParam = historyFilter === 'ALL' ? undefined : historyFilter;
      const response = await shiftSwapService.list(teamId, {
        page,
        limit: 30,
        status: statusParam,
      });

      const historyOnly =
        historyFilter === 'ALL'
          ? response.shiftSwaps.filter(
              (s) => !['PENDING_PEER', 'PENDING_MANAGER'].includes(s.status)
            )
          : response.shiftSwaps;

      return {
        shiftSwaps: historyOnly,
        pagination: response.pagination,
      };
    },
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Loads exact tab badge counts from backend and caches under TanStack Query.
 */
export function useShiftSwapsTabCounts(teamId?: string, userId?: string) {
  return useQuery<ShiftSwapTabCounts, Error>({
    queryKey: queryKeys.shiftSwaps.tabCounts(teamId ?? '', userId ?? ''),
    queryFn: async (): Promise<ShiftSwapTabCounts> => {
      if (!teamId || !userId) {
        return { incoming: 0, myRequests: 0, managerReview: 0 };
      }

      const [peerRes, mgrRes] = await Promise.all([
        shiftSwapService.list(teamId, { status: 'PENDING_PEER', limit: 100 }),
        shiftSwapService.list(teamId, { status: 'PENDING_MANAGER', limit: 100 }),
      ]);

      const incoming = peerRes.shiftSwaps.filter((s) => s.receivingUserId === userId).length;
      const myPeer = peerRes.shiftSwaps.filter((s) => s.requestingUserId === userId).length;
      const myMgr = mgrRes.shiftSwaps.filter((s) => s.requestingUserId === userId).length;
      const myRequests = myPeer + myMgr;
      const managerReview = mgrRes.pagination.total;

      return { incoming, myRequests, managerReview };
    },
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Queries and caches user role in active team.
 */
export function useShiftSwapRole(teamId?: string, userId?: string) {
  return useQuery<TeamRole | null, Error>({
    queryKey: ['teamRole', teamId, userId],
    queryFn: async (): Promise<TeamRole | null> => {
      if (!teamId || !userId) return null;
      try {
        const members = await teamService.listAllMembers(teamId);
        const myMember = members.find((m) => m.userId === userId);
        return myMember?.role || null;
      } catch {
        return null;
      }
    },
    enabled: Boolean(teamId && userId),
  });
}
