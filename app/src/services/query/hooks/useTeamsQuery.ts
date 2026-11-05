import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamService } from '@/services/api/teamService';
import { queryKeys } from '../queryKeys';
import { TeamsResponse } from '@/types/api';

/**
 * Hook to retrieve teams for the authenticated user.
 */
export function useTeams(userId?: string) {
  return useQuery({
    queryKey: queryKeys.teams.list(userId ?? ''),
    queryFn: () => teamService.list(),
    enabled: Boolean(userId),
  });
}

/**
 * Mutation hook to create a new team with targeted query invalidation.
 */
export function useCreateTeam(userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => teamService.create(name),
    onSuccess: () => {
      if (userId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.teams.all(userId) });
      }
    },
  });
}

