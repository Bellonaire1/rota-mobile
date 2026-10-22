import { apiClient } from './apiClient';
import { Team, TeamResponse, TeamsResponse } from '@/types/api';

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
};

export type { Team };
