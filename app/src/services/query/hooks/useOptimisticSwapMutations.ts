import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RespondShiftSwapInput,
  ReviewShiftSwapInput,
  shiftSwapService,
} from '@/services/api/shiftSwapService';
import { queryKeys } from '../queryKeys';
import { ShiftSwap, ShiftSwapResponse, ShiftSwapsResponse } from '@/types/api';
import { PendingSwapsSummary } from './useShiftsQuery';
import { ShiftSwapTabCounts, ShiftSwapsTabResult } from './useShiftSwapsQuery';

/**
 * Optimistic mutation for Peer Response (accept or decline).
 *
 * Updates visible INCOMING tab list and tab badge counts immediately in cache,
 * with non-clobbering rollback on failure and authoritative server invalidation onSettled.
 */
export function useOptimisticSwapRespond(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      swapId,
      input,
    }: {
      swapId: string;
      input: RespondShiftSwapInput;
    }): Promise<ShiftSwapResponse> => {
      if (!teamId) throw new Error('teamId required');
      return shiftSwapService.respond(teamId, swapId, input);
    },
    onMutate: async ({ swapId }) => {
      if (!teamId || !userId) return;

      // 1. Cancel ongoing queries for shift swaps
      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });

      // 2. Target query keys
      const incomingTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'INCOMING', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);
      const legacyListKey = queryKeys.shiftSwaps.list(teamId, userId, { status: 'PENDING_PEER' });
      const pendingCountsKey = queryKeys.shiftSwaps.pendingCounts(teamId, userId);

      // 3. Capture snapshots
      const previousIncomingTab = queryClient.getQueryData<ShiftSwapsTabResult>(incomingTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);
      const previousLegacyList = queryClient.getQueryData<ShiftSwapsResponse>(legacyListKey);
      const previousPendingCounts = queryClient.getQueryData<PendingSwapsSummary>(pendingCountsKey);

      let removedSwap: ShiftSwap | null = null;

      // 4. Optimistically update INCOMING tab
      if (previousIncomingTab) {
        removedSwap = previousIncomingTab.shiftSwaps.find((s) => s.id === swapId) || null;
        queryClient.setQueryData<ShiftSwapsTabResult>(incomingTabKey, {
          ...previousIncomingTab,
          shiftSwaps: previousIncomingTab.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousIncomingTab.pagination,
            total: Math.max(0, previousIncomingTab.pagination.total - 1),
          },
        });
      }

      // 5. Optimistically update Tab Counts
      if (previousTabCounts) {
        queryClient.setQueryData<ShiftSwapTabCounts>(tabCountsKey, {
          ...previousTabCounts,
          incoming: Math.max(0, previousTabCounts.incoming - 1),
        });
      }

      // 6. Optimistically update legacy list and pending counts for dashboard badge
      if (previousLegacyList) {
        if (!removedSwap) {
          removedSwap = previousLegacyList.shiftSwaps.find((s) => s.id === swapId) || null;
        }
        queryClient.setQueryData<ShiftSwapsResponse>(legacyListKey, {
          ...previousLegacyList,
          shiftSwaps: previousLegacyList.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousLegacyList.pagination,
            total: Math.max(0, previousLegacyList.pagination.total - 1),
          },
        });
      }

      if (previousPendingCounts) {
        queryClient.setQueryData<PendingSwapsSummary>(pendingCountsKey, {
          ...previousPendingCounts,
          pendingSwapCount: Math.max(0, previousPendingCounts.pendingSwapCount - 1),
        });
      }

      return {
        swapId,
        removedSwap,
        incomingTabKey,
        tabCountsKey,
        legacyListKey,
        pendingCountsKey,
        previousIncomingTab,
        previousTabCounts,
        previousLegacyList,
        previousPendingCounts,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      // Rollback without clobbering concurrent mutations:
      // If removedSwap exists, re-insert it into current cache if not already present
      if (context.incomingTabKey && context.removedSwap) {
        queryClient.setQueryData<ShiftSwapsTabResult>(context.incomingTabKey, (current) => {
          if (!current) return context.previousIncomingTab;
          if (current.shiftSwaps.some((s) => s.id === context.swapId)) return current;
          return {
            ...current,
            shiftSwaps: [context.removedSwap!, ...current.shiftSwaps],
            pagination: { ...current.pagination, total: current.pagination.total + 1 },
          };
        });
      }

      if (context.tabCountsKey) {
        queryClient.setQueryData<ShiftSwapTabCounts>(context.tabCountsKey, (current) => {
          if (!current) return context.previousTabCounts;
          return { ...current, incoming: current.incoming + 1 };
        });
      }

      if (context.legacyListKey && context.removedSwap) {
        queryClient.setQueryData<ShiftSwapsResponse>(context.legacyListKey, (current) => {
          if (!current) return context.previousLegacyList;
          if (current.shiftSwaps.some((s) => s.id === context.swapId)) return current;
          return {
            ...current,
            shiftSwaps: [context.removedSwap!, ...current.shiftSwaps],
            pagination: { ...current.pagination, total: current.pagination.total + 1 },
          };
        });
      }

      if (context.pendingCountsKey) {
        queryClient.setQueryData<PendingSwapsSummary>(context.pendingCountsKey, (current) => {
          if (!current) return context.previousPendingCounts;
          return { ...current, pendingSwapCount: current.pendingSwapCount + 1 };
        });
      }
    },
    onSettled: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shiftSwaps.all(teamId, userId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
      }
    },
  });
}

/**
 * Optimistic mutation for Manager Review (approve or reject).
 */
export function useOptimisticSwapReview(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      swapId,
      input,
    }: {
      swapId: string;
      input: ReviewShiftSwapInput;
    }): Promise<ShiftSwapResponse> => {
      if (!teamId) throw new Error('teamId required');
      return shiftSwapService.review(teamId, swapId, input);
    },
    onMutate: async ({ swapId }) => {
      if (!teamId || !userId) return;

      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });

      const mgrTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'MANAGER_REVIEW', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);
      const legacyMgrKey = queryKeys.shiftSwaps.list(teamId, userId, {
        status: 'PENDING_MANAGER',
      });

      const previousMgrTab = queryClient.getQueryData<ShiftSwapsTabResult>(mgrTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);
      const previousLegacyMgr = queryClient.getQueryData<ShiftSwapsResponse>(legacyMgrKey);

      let removedSwap: ShiftSwap | null = null;

      if (previousMgrTab) {
        removedSwap = previousMgrTab.shiftSwaps.find((s) => s.id === swapId) || null;
        queryClient.setQueryData<ShiftSwapsTabResult>(mgrTabKey, {
          ...previousMgrTab,
          shiftSwaps: previousMgrTab.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousMgrTab.pagination,
            total: Math.max(0, previousMgrTab.pagination.total - 1),
          },
        });
      }

      if (previousTabCounts) {
        queryClient.setQueryData<ShiftSwapTabCounts>(tabCountsKey, {
          ...previousTabCounts,
          managerReview: Math.max(0, previousTabCounts.managerReview - 1),
        });
      }

      if (previousLegacyMgr) {
        if (!removedSwap) {
          removedSwap = previousLegacyMgr.shiftSwaps.find((s) => s.id === swapId) || null;
        }
        queryClient.setQueryData<ShiftSwapsResponse>(legacyMgrKey, {
          ...previousLegacyMgr,
          shiftSwaps: previousLegacyMgr.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousLegacyMgr.pagination,
            total: Math.max(0, previousLegacyMgr.pagination.total - 1),
          },
        });
      }

      return {
        swapId,
        removedSwap,
        mgrTabKey,
        tabCountsKey,
        legacyMgrKey,
        previousMgrTab,
        previousTabCounts,
        previousLegacyMgr,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      if (context.mgrTabKey && context.removedSwap) {
        queryClient.setQueryData<ShiftSwapsTabResult>(context.mgrTabKey, (current) => {
          if (!current) return context.previousMgrTab;
          if (current.shiftSwaps.some((s) => s.id === context.swapId)) return current;
          return {
            ...current,
            shiftSwaps: [context.removedSwap!, ...current.shiftSwaps],
            pagination: { ...current.pagination, total: current.pagination.total + 1 },
          };
        });
      }

      if (context.tabCountsKey) {
        queryClient.setQueryData<ShiftSwapTabCounts>(context.tabCountsKey, (current) => {
          if (!current) return context.previousTabCounts;
          return { ...current, managerReview: current.managerReview + 1 };
        });
      }

      if (context.legacyMgrKey && context.removedSwap) {
        queryClient.setQueryData<ShiftSwapsResponse>(context.legacyMgrKey, (current) => {
          if (!current) return context.previousLegacyMgr;
          if (current.shiftSwaps.some((s) => s.id === context.swapId)) return current;
          return {
            ...current,
            shiftSwaps: [context.removedSwap!, ...current.shiftSwaps],
            pagination: { ...current.pagination, total: current.pagination.total + 1 },
          };
        });
      }
    },
    onSettled: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shiftSwaps.all(teamId, userId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
      }
    },
  });
}

/**
 * Optimistic mutation for Requesting User Cancel.
 *
 * Optimistically removes the cancelled swap from MY_REQUESTS tab and decrements
 * myRequests tab badge count, with automatic rollback on network failure or 409 conflict.
 */
export function useOptimisticSwapCancel(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (swapId: string): Promise<ShiftSwapResponse> => {
      if (!teamId) throw new Error('teamId required');
      return shiftSwapService.cancel(teamId, swapId);
    },
    onMutate: async (swapId: string) => {
      if (!teamId || !userId) return;

      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });

      const myRequestsTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'MY_REQUESTS', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);

      const previousMyRequestsTab = queryClient.getQueryData<ShiftSwapsTabResult>(myRequestsTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);

      let removedSwap: ShiftSwap | null = null;

      if (previousMyRequestsTab) {
        removedSwap = previousMyRequestsTab.shiftSwaps.find((s) => s.id === swapId) || null;
        queryClient.setQueryData<ShiftSwapsTabResult>(myRequestsTabKey, {
          ...previousMyRequestsTab,
          shiftSwaps: previousMyRequestsTab.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousMyRequestsTab.pagination,
            total: Math.max(0, previousMyRequestsTab.pagination.total - 1),
          },
        });
      }

      if (previousTabCounts) {
        queryClient.setQueryData<ShiftSwapTabCounts>(tabCountsKey, {
          ...previousTabCounts,
          myRequests: Math.max(0, previousTabCounts.myRequests - 1),
        });
      }

      return {
        swapId,
        removedSwap,
        myRequestsTabKey,
        tabCountsKey,
        previousMyRequestsTab,
        previousTabCounts,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      if (context.myRequestsTabKey && context.removedSwap) {
        queryClient.setQueryData<ShiftSwapsTabResult>(context.myRequestsTabKey, (current) => {
          if (!current) return context.previousMyRequestsTab;
          if (current.shiftSwaps.some((s) => s.id === context.swapId)) return current;
          return {
            ...current,
            shiftSwaps: [context.removedSwap!, ...current.shiftSwaps],
            pagination: { ...current.pagination, total: current.pagination.total + 1 },
          };
        });
      }

      if (context.tabCountsKey) {
        queryClient.setQueryData<ShiftSwapTabCounts>(context.tabCountsKey, (current) => {
          if (!current) return context.previousTabCounts;
          return { ...current, myRequests: current.myRequests + 1 };
        });
      }
    },
    onSettled: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shiftSwaps.all(teamId, userId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
      }
    },
  });
}
