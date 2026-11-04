import { apiClient } from './apiClient';
import { ActivityFeedQuery, ActivityFeedResponse } from '@/types/api';

/**
 * Service for interacting with team activity feed endpoints.
 * Consumes GET /api/v1/teams/:teamId/activity with keyset cursor pagination.
 */
export const activityService = {
  /**
   * Fetches a page of chronological activity events for the specified team.
   *
   * @param teamId The team identifier (UUID)
   * @param query Optional pagination options (limit: 1-100, cursor: opaque string)
   * @returns ActivityFeedResponse containing events array and cursor pagination metadata
   */
  async getTeamActivity(teamId: string, query?: ActivityFeedQuery): Promise<ActivityFeedResponse> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) {
      params.append('limit', String(query.limit));
    }
    if (query?.cursor) {
      params.append('cursor', query.cursor);
    }
    const queryString = params.toString();
    const endpoint = `/teams/${encodeURIComponent(teamId)}/activity${queryString ? `?${queryString}` : ''}`;
    return apiClient.get<ActivityFeedResponse>(endpoint);
  },
};
