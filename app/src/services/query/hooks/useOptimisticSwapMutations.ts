import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RespondShiftSwapInput,
  ReviewShiftSwapInput,
  shiftSwapService,
} from '@/services/api/shiftSwapService';
import { queryKeys } from '../queryKeys';
import { ShiftSwapResponse, ShiftSwapsResponse } from '@/types/api';
import { PendingSwapsSummary } from './useShiftsQuery';

/**
 * Optimistic mutation for Peer Response (accept or decline).
 *
 * Implements standard TanStack Query optimistic update with complete rollback on failure.
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
    onMutate: async ({ swapId, input }) => {
      if (!teamId || !userId) return;

      // 1. Cancel ongoing queries for shift swaps
      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });

      // 2. Snapshot current state for rollback
      const peerListKey = queryKeys.shiftSwaps.list(teamId, userId, {
        status: 'PENDING_PEER',
      });
      const countsKey = queryKeys.shiftSwaps.pendingCounts(teamId, userId);

      const previousPeerList = queryClient.getQueryData<ShiftSwapsResponse>(peerListKey);
      const previousCounts = queryClient.getQueryData<PendingSwapsSummary>(countsKey);

      // 3. Apply optimistic update to peer list
      if (previousPeerList) {
        queryClient.setQueryData<ShiftSwapsResponse>(peerListKey, {
          ...previousPeerList,
          shiftSwaps: previousPeerList.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousPeerList.pagination,
            total: Math.max(0, previousPeerList.pagination.total - 1),
          },
        });
      }

      // 4. Apply optimistic update to counts badge
      if (previousCounts) {
        queryClient.setQueryData<PendingSwapsSummary>(countsKey, {
          ...previousCounts,
          pendingSwapCount: Math.max(0, previousCounts.pendingSwapCount - 1),
        });
      }

      return { previousPeerList, previousCounts, peerListKey, countsKey };
    },
    onError: (_err, _variables, context) => {
      // Roll back to prior snapshot on failure (e.g. 409 conflict, network error)
      if (context?.previousPeerList && context.peerListKey) {
        queryClient.setQueryData(context.peerListKey, context.previousPeerList);
      }
      if (context?.previousCounts && context.countsKey) {
        queryClient.setQueryData(context.countsKey, context.previousCounts);
      }
    },
    onSettled: () => {
      // Reconcile with authoritative server state
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

      // 1. Cancel in-flight queries
      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });

      // 2. Snapshot current state
      const managerListKey = queryKeys.shiftSwaps.list(teamId, userId, {
        status: 'PENDING_MANAGER',
      });
      const countsKey = queryKeys.shiftSwaps.pendingCounts(teamId, userId);

      const previousManagerList =
        queryClient.getQueryData<ShiftSwapsResponse>(managerListKey);
      const previousCounts = queryClient.getQueryData<PendingSwapsSummary>(countsKey);

      // 3. Optimistically remove from manager review list
      if (previousManagerList) {
        queryClient.setQueryData<ShiftSwapsResponse>(managerListKey, {
          ...previousManagerList,
          shiftSwaps: previousManagerList.shiftSwaps.filter((s) => s.id !== swapId),
          pagination: {
            ...previousManagerList.pagination,
            total: Math.max(0, previousManagerList.pagination.total - 1),
          },
        });
      }

      // 4. Decrement badge counts
      if (previousCounts) {
        queryClient.setQueryData<PendingSwapsSummary>(countsKey, {
          ...previousCounts,
          pendingSwapCount: Math.max(0, previousCounts.pendingSwapCount - 1),
        });
      }

      return { previousManagerList, previousCounts, managerListKey, countsKey };
    },
    onError: (_err, _variables, context) => {
      // Rollback on conflict / network error
      if (context?.previousManagerList && context.managerListKey) {
        queryClient.setQueryData(context.managerListKey, context.previousManagerList);
      }
      if (context?.previousCounts && context.countsKey) {
        queryClient.setQueryData(context.countsKey, context.previousCounts);
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
 */
export function useOptimisticSwapCancel(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (swapId: string): Promise<ShiftSwapResponse> => {
      if (!teamId) throw new Error('teamId required');
      return shiftSwapService.cancel(teamId, swapId);
    },
    onMutate: async () => {
      if (!teamId || !userId) return;
      await queryClient.cancelQueries({
        queryKey: queryKeys.shiftSwaps.all(teamId, userId),
      });
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

