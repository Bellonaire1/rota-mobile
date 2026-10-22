import { apiClient } from './apiClient';
import { Team, TeamMember, TeamMembersResponse, TeamResponse, TeamsResponse, TeamRole } from '@/types/api';

export const teamService = {
  list(): Promise<TeamsResponse> {
    return apiClient.get<TeamsResponse>('/teams');
  },

  create(name: string): Promise<TeamResponse> {
    return apiClient.post<TeamResponse>('/teams', { name });
  },

  get(teamId: string): Promise<TeamResponse> {
    return apiClient.get<TeamResponse>(`/teams/${teamId}`);
  },

  listMembers(teamId: string, page = 1, limit = 100): Promise<TeamMembersResponse> {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    return apiClient.get<TeamMembersResponse>(`/teams/${teamId}/members?${query.toString()}`);
  },

  async listAllMembers(teamId: string): Promise<TeamMember[]> {
    const firstPage = await this.listMembers(teamId);
    const members = [...firstPage.members];
    for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
      const response = await this.listMembers(teamId, page);
      members.push(...response.members);
    }
    return members;
  },

  addMember(teamId: string, userId: string, role: Exclude<TeamRole, 'OWNER'> = 'STAFF'): Promise<{ member: TeamMember }> {
    return apiClient.post<{ member: TeamMember }>(`/teams/${teamId}/members`, { userId, role });
  },

  updateMemberRole(teamId: string, userId: string, role: Exclude<TeamRole, 'OWNER'>): Promise<{ member: TeamMember }> {
    return apiClient.patch<{ member: TeamMember }>(`/teams/${teamId}/members/${userId}/role`, { role });
  },

  removeMember(teamId: string, userId: string): Promise<unknown> {
    return apiClient.delete<unknown>(`/teams/${teamId}/members/${userId}`);
  },
};

export type { Team };
