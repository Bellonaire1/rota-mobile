import { apiClient } from './apiClient';
import {
  CreateInvitationInput,
  InvitationAcceptResponse,
  InvitationPreview,
  InvitationPreviewResponse,
  TeamInvitation,
  TeamInvitationsListResponse,
  TeamInvitationSingleResponse,
} from '@/types/api';

export const teamInvitationService = {
  /**
   * Preview invitation details for the currently authenticated user.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const response = await apiClient.post<InvitationPreviewResponse>(
      '/team-invitations/preview',
      { token }
    );
    return response.invitation;
  },

  /**
   * Accept an invitation and join the team.
   */
  async accept(token: string): Promise<InvitationAcceptResponse> {
    return apiClient.post<InvitationAcceptResponse>(
      '/team-invitations/accept',
      { token }
    );
  },

  /**
   * Team OWNER creates an invitation for an email address.
   */
  async create(teamId: string, input: CreateInvitationInput): Promise<TeamInvitation> {
    const response = await apiClient.post<TeamInvitationSingleResponse>(
      `/teams/${teamId}/invitations`,
      input
    );
    return response.invitation;
  },

  /**
   * Team OWNER lists all invitations for the team.
   */
  async list(teamId: string): Promise<TeamInvitation[]> {
    const response = await apiClient.get<TeamInvitationsListResponse>(
      `/teams/${teamId}/invitations`
    );
    return response.invitations;
  },

  /**
   * Team OWNER revokes a pending invitation.
   */
  async revoke(teamId: string, invitationId: string): Promise<TeamInvitation> {
    const response = await apiClient.post<TeamInvitationSingleResponse>(
      `/teams/${teamId}/invitations/${invitationId}/revoke`
    );
    return response.invitation;
  },
};
