import { InfiniteData, useMutation, useQueryClient } from '@tanstack/react-query';
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
 * Updates visible INCOMING tab list (both infinite and single-page) and tab badge counts
 * immediately in cache, with non-clobbering rollback on failure and authoritative
 * server invalidation onSettled.
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
      const infiniteIncomingKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'INCOMING', 'ALL');
      const incomingTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'INCOMING', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);
      const legacyListKey = queryKeys.shiftSwaps.list(teamId, userId, { status: 'PENDING_PEER' });
      const pendingCountsKey = queryKeys.shiftSwaps.pendingCounts(teamId, userId);

      // 3. Capture snapshots
      const previousInfiniteIncoming =
        queryClient.getQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteIncomingKey);
      const previousIncomingTab = queryClient.getQueryData<ShiftSwapsTabResult>(incomingTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);
      const previousLegacyList = queryClient.getQueryData<ShiftSwapsResponse>(legacyListKey);
      const previousPendingCounts = queryClient.getQueryData<PendingSwapsSummary>(pendingCountsKey);

      let removedSwap: ShiftSwap | null = null;
      let targetPageIndex = -1;

      // 4. Optimistically update INCOMING infinite tab (handles items on any page)
      if (previousInfiniteIncoming?.pages) {
        for (let i = 0; i < previousInfiniteIncoming.pages.length; i++) {
          const found = previousInfiniteIncoming.pages[i].shiftSwaps.find((s) => s.id === swapId);
          if (found) {
            removedSwap = found;
            targetPageIndex = i;
            break;
          }
        }

        if (removedSwap && targetPageIndex >= 0) {
          queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteIncomingKey, {
            ...previousInfiniteIncoming,
            pages: previousInfiniteIncoming.pages.map((page, idx) => {
              if (idx !== targetPageIndex) return page;
              return {
                ...page,
                shiftSwaps: page.shiftSwaps.filter((s) => s.id !== swapId),
                pagination: {
                  ...page.pagination,
                  total: Math.max(0, page.pagination.total - 1),
                },
              };
            }),
          });
        }
      }

      // 5. Optimistically update INCOMING single-page tab (if present)
      if (previousIncomingTab) {
        if (!removedSwap) {
          removedSwap = previousIncomingTab.shiftSwaps.find((s) => s.id === swapId) || null;
        }
        queryClient.setQueryData<ShiftSwapsTabResult>(incomingTabKey, {
          ...previousIncomingTab,
          shiftSwaps: previousIncomingTab.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousIncomingTab.pagination,
            total: Math.max(0, previousIncomingTab.pagination.total - 1),
          },
        });
      }

      // 6. Optimistically update Tab Counts
      if (previousTabCounts) {
        queryClient.setQueryData<ShiftSwapTabCounts>(tabCountsKey, {
          ...previousTabCounts,
          incoming: Math.max(0, previousTabCounts.incoming - 1),
        });
      }

      // 7. Optimistically update legacy list and pending counts for dashboard badge
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
        targetPageIndex,
        infiniteIncomingKey,
        incomingTabKey,
        tabCountsKey,
        legacyListKey,
        pendingCountsKey,
        previousInfiniteIncoming,
        previousIncomingTab,
        previousTabCounts,
        previousLegacyList,
        previousPendingCounts,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      // Rollback infinite tab without clobbering concurrent mutations
      if (context.infiniteIncomingKey && context.removedSwap && context.targetPageIndex >= 0) {
        queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(
          context.infiniteIncomingKey,
          (current) => {
            if (!current) return context.previousInfiniteIncoming;
            const alreadyPresent = current.pages.some((page) =>
              page.shiftSwaps.some((s) => s.id === context.swapId)
            );
            if (alreadyPresent) return current;

            return {
              ...current,
              pages: current.pages.map((page, idx) => {
                if (idx !== context.targetPageIndex) return page;
                return {
                  ...page,
                  shiftSwaps: [context.removedSwap!, ...page.shiftSwaps],
                  pagination: {
                    ...page.pagination,
                    total: page.pagination.total + 1,
                  },
                };
              }),
            };
          }
        );
      }

      // Rollback single-page tab
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

      const infiniteMgrKey = queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'MANAGER_REVIEW', 'ALL');
      const mgrTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'MANAGER_REVIEW', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);
      const legacyMgrKey = queryKeys.shiftSwaps.list(teamId, userId, {
        status: 'PENDING_MANAGER',
      });

      const previousInfiniteMgr =
        queryClient.getQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteMgrKey);
      const previousMgrTab = queryClient.getQueryData<ShiftSwapsTabResult>(mgrTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);
      const previousLegacyMgr = queryClient.getQueryData<ShiftSwapsResponse>(legacyMgrKey);

      let removedSwap: ShiftSwap | null = null;
      let targetPageIndex = -1;

      // Optimistically update infinite manager review tab
      if (previousInfiniteMgr?.pages) {
        for (let i = 0; i < previousInfiniteMgr.pages.length; i++) {
          const found = previousInfiniteMgr.pages[i].shiftSwaps.find((s) => s.id === swapId);
          if (found) {
            removedSwap = found;
            targetPageIndex = i;
            break;
          }
        }

        if (removedSwap && targetPageIndex >= 0) {
          queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteMgrKey, {
            ...previousInfiniteMgr,
            pages: previousInfiniteMgr.pages.map((page, idx) => {
              if (idx !== targetPageIndex) return page;
              return {
                ...page,
                shiftSwaps: page.shiftSwaps.filter((s) => s.id !== swapId),
                pagination: {
                  ...page.pagination,
                  total: Math.max(0, page.pagination.total - 1),
                },
              };
            }),
          });
        }
      }

      // Optimistically update single-page manager tab
      if (previousMgrTab) {
        if (!removedSwap) {
          removedSwap = previousMgrTab.shiftSwaps.find((s) => s.id === swapId) || null;
        }
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
        targetPageIndex,
        infiniteMgrKey,
        mgrTabKey,
        tabCountsKey,
        legacyMgrKey,
        previousInfiniteMgr,
        previousMgrTab,
        previousTabCounts,
        previousLegacyMgr,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      if (context.infiniteMgrKey && context.removedSwap && context.targetPageIndex >= 0) {
        queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(
          context.infiniteMgrKey,
          (current) => {
            if (!current) return context.previousInfiniteMgr;
            const alreadyPresent = current.pages.some((page) =>
              page.shiftSwaps.some((s) => s.id === context.swapId)
            );
            if (alreadyPresent) return current;

            return {
              ...current,
              pages: current.pages.map((page, idx) => {
                if (idx !== context.targetPageIndex) return page;
                return {
                  ...page,
                  shiftSwaps: [context.removedSwap!, ...page.shiftSwaps],
                  pagination: {
                    ...page.pagination,
                    total: page.pagination.total + 1,
                  },
                };
              }),
            };
          }
        );
      }

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
 * Optimistically removes the cancelled swap from MY_REQUESTS tab (both infinite and single page)
 * and decrements myRequests tab badge count, with automatic rollback on failure.
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

      const infiniteMyRequestsKey =
        queryKeys.shiftSwaps.infiniteTab(teamId, userId, 'MY_REQUESTS', 'ALL');
      const myRequestsTabKey = queryKeys.shiftSwaps.tab(teamId, userId, 'MY_REQUESTS', 'ALL', 1);
      const tabCountsKey = queryKeys.shiftSwaps.tabCounts(teamId, userId);

      const previousInfiniteMyRequests =
        queryClient.getQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteMyRequestsKey);
      const previousMyRequestsTab =
        queryClient.getQueryData<ShiftSwapsTabResult>(myRequestsTabKey);
      const previousTabCounts = queryClient.getQueryData<ShiftSwapTabCounts>(tabCountsKey);

      let removedSwap: ShiftSwap | null = null;
      let targetPageIndex = -1;

      // Optimistically update infinite MY_REQUESTS tab
      if (previousInfiniteMyRequests?.pages) {
        for (let i = 0; i < previousInfiniteMyRequests.pages.length; i++) {
          const found = previousInfiniteMyRequests.pages[i].shiftSwaps.find((s) => s.id === swapId);
          if (found) {
            removedSwap = found;
            targetPageIndex = i;
            break;
          }
        }

        if (removedSwap && targetPageIndex >= 0) {
          queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(infiniteMyRequestsKey, {
            ...previousInfiniteMyRequests,
            pages: previousInfiniteMyRequests.pages.map((page, idx) => {
              if (idx !== targetPageIndex) return page;
              return {
                ...page,
                shiftSwaps: page.shiftSwaps.filter((s) => s.id !== swapId),
                pagination: {
                  ...page.pagination,
                  total: Math.max(0, page.pagination.total - 1),
                },
              };
            }),
          });
        }
      }

      // Optimistically update single-page MY_REQUESTS tab
      if (previousMyRequestsTab) {
        if (!removedSwap) {
          removedSwap = previousMyRequestsTab.shiftSwaps.find((s) => s.id === swapId) || null;
        }
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
        targetPageIndex,
        infiniteMyRequestsKey,
        myRequestsTabKey,
        tabCountsKey,
        previousInfiniteMyRequests,
        previousMyRequestsTab,
        previousTabCounts,
      };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;

      if (
        context.infiniteMyRequestsKey &&
        context.removedSwap &&
        context.targetPageIndex >= 0
      ) {
        queryClient.setQueryData<InfiniteData<ShiftSwapsTabResult>>(
          context.infiniteMyRequestsKey,
          (current) => {
            if (!current) return context.previousInfiniteMyRequests;
            const alreadyPresent = current.pages.some((page) =>
              page.shiftSwaps.some((s) => s.id === context.swapId)
            );
            if (alreadyPresent) return current;

            return {
              ...current,
              pages: current.pages.map((page, idx) => {
                if (idx !== context.targetPageIndex) return page;
                return {
                  ...page,
                  shiftSwaps: [context.removedSwap!, ...page.shiftSwaps],
                  pagination: {
                    ...page.pagination,
                    total: page.pagination.total + 1,
                  },
                };
              }),
            };
          }
        );
      }

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
