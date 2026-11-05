import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamService } from '@/services/api/teamService';
import { teamInvitationService } from '@/services/api/teamInvitationService';
import { queryKeys } from '../queryKeys';
import { CreateInvitationInput, TeamRole } from '@/types/api';

/**
 * Hook to retrieve a paginated page of team members.
 */
export function useTeamMembers(
  teamId?: string,
  userId?: string,
  page = 1,
  limit = 20
) {
  return useQuery({
    queryKey: queryKeys.members.list(teamId ?? '', userId ?? '', { page, limit }),
    queryFn: () => teamService.listMembers(teamId!, page, limit),
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Infinite query hook for team members.
 * Keeps all loaded pages in query cache, eliminating component-level accumulation
 * and cross-team stale data rendering.
 */
export function useInfiniteTeamMembers(
  teamId?: string,
  userId?: string,
  limit = 20
) {
  return useInfiniteQuery({
    queryKey: queryKeys.members.infinite(teamId ?? '', userId ?? '', { limit }),
    queryFn: ({ pageParam = 1 }) =>
      teamService.listMembers(teamId!, pageParam as number, limit),
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
 * Hook to retrieve all team members (exhaustively paginated) for assignment lists.
 */
export function useTeamAllMembers(teamId?: string, userId?: string) {
  return useQuery({
    queryKey: queryKeys.members.allList(teamId ?? '', userId ?? ''),
    queryFn: () => teamService.listAllMembers(teamId!),
    enabled: Boolean(teamId && userId),
  });
}

/**
 * Hook to retrieve pending team invitations (for team OWNER).
 */
export function useTeamInvitations(
  teamId?: string,
  userId?: string,
  isOwner = false
) {
  return useQuery({
    queryKey: queryKeys.members.invitations(teamId ?? '', userId ?? ''),
    queryFn: () => teamInvitationService.list(teamId!),
    enabled: Boolean(teamId && userId && isOwner),
  });
}

/**
 * Mutations for team members and invitations with targeted cache invalidation.
 */
export function useAddMember(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      newUserId,
      role,
    }: {
      newUserId: string;
      role?: Exclude<TeamRole, 'OWNER'>;
    }) => teamService.addMember(teamId!, newUserId, role),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.members.all(teamId, userId),
        });
      }
    },
  });
}

export function useUpdateMemberRole(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      memberUserId,
      role,
    }: {
      memberUserId: string;
      role: Exclude<TeamRole, 'OWNER'>;
    }) => teamService.updateMemberRole(teamId!, memberUserId, role),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.members.all(teamId, userId),
        });
      }
    },
  });
}

export function useRemoveMember(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (memberUserId: string) =>
      teamService.removeMember(teamId!, memberUserId),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.members.all(teamId, userId),
        });
      }
    },
  });
}

export function useCreateInvitation(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateInvitationInput) =>
      teamInvitationService.create(teamId!, input),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.members.invitations(teamId, userId),
        });
      }
    },
  });
}

export function useRevokeInvitation(teamId?: string, userId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invitationId: string) =>
      teamInvitationService.revoke(teamId!, invitationId),
    onSuccess: () => {
      if (teamId && userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.members.invitations(teamId, userId),
        });
      }
    },
  });
}
