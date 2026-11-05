import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateShiftInput,
  ShiftListParams,
  shiftService,
  UpdateShiftInput,
} from '@/services/api/shiftService';
import { shiftSwapService } from '@/services/api/shiftSwapService';
import { queryKeys } from '../queryKeys';

export interface PendingSwapsSummary {
  pendingSwapCount: number;
  activeSwapShiftIds: Set<string>;
}

/**
 * Hook to retrieve a single page of shifts according to filters and pagination.
 */
export function useShifts(
  teamId?: string,
  userId?: string,
  params: ShiftListParams = {}
) {
  return useQuery({
    queryKey: queryKeys.shifts.list(teamId ?? '', userId ?? '', params),
    queryFn: () => shiftService.list(teamId!, params),
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Infinite query hook for paginated shifts.
 * Stores all loaded pages directly in the query cache, eliminating component-level
 * accumulated state and preventing cross-team / cross-filter rendering flashes.
 */
export function useInfiniteShifts(
  teamId?: string,
  userId?: string,
  params: Omit<ShiftListParams, 'page'> = {}
) {
  return useInfiniteQuery({
    queryKey: queryKeys.shifts.infinite(teamId ?? '', userId ?? '', params),
    queryFn: ({ pageParam = 1 }) =>
      shiftService.list(teamId!, { ...params, page: pageParam as number, limit: 20 }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (lastPage.pagination.page < lastPage.pagination.totalPages) {
        return lastPage.pagination.page + 1;
      }
      return undefined;
    },
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Hook to retrieve summary of pending shift swaps (counts and affected shift IDs).
 */
export function usePendingSwapsSummary(teamId?: string, userId?: string) {
  return useQuery<PendingSwapsSummary>({
    queryKey: queryKeys.shiftSwaps.pendingCounts(teamId ?? '', userId ?? ''),
    queryFn: async () => {
      const [peerRes, mgrRes] = await Promise.all([
        shiftSwapService.list(teamId!, { status: 'PENDING_PEER', limit: 100 }),
        shiftSwapService.list(teamId!, { status: 'PENDING_MANAGER', limit: 100 }),
      ]);

      const ids = new Set<string>();
      peerRes.shiftSwaps.forEach((s) => {
        ids.add(s.sourceShiftId);
        ids.add(s.targetShiftId);
      });
      mgrRes.shiftSwaps.forEach((s) => {
        ids.add(s.sourceShiftId);
        ids.add(s.targetShiftId);
      });

      return {
        pendingSwapCount: peerRes.pagination.total + mgrRes.pagination.total,
        activeSwapShiftIds: ids,
      };
    },
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Mutation hook to create a shift with targeted invalidations.
 */
export function useCreateShift(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateShiftInput) => shiftService.create(teamId!, input),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
      }
    },
  });
}

/**
 * Mutation hook to update a shift with targeted invalidations.
 */
export function useUpdateShift(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      shiftId,
      input,
    }: {
      shiftId: string;
      input: UpdateShiftInput;
    }) => shiftService.update(teamId!, shiftId, input),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
      }
    },
  });
}

/**
 * Mutation hook to cancel a shift with targeted invalidations.
 */
export function useCancelShift(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      shiftId,
      updatedAt,
    }: {
      shiftId: string;
      updatedAt: string;
    }) => shiftService.cancel(teamId!, shiftId, updatedAt),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.shifts.all(teamId, userId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.shiftSwaps.all(teamId, userId),
        });
      }
    },
  });
}
