import { apiClient } from './apiClient';
import {
  Pagination,
  ShiftSwap,
  ShiftSwapResponse,
  ShiftSwapsResponse,
  ShiftSwapStatus,
} from '@/types/api';

export interface ShiftSwapListParams {
  page?: number;
  limit?: number;
  status?: ShiftSwapStatus;
}

export interface CreateShiftSwapInput {
  sourceShiftId: string;
  targetShiftId: string;
}

export interface RespondShiftSwapInput {
  action: 'accept' | 'decline';
}

export interface ReviewShiftSwapInput {
  action: 'approve' | 'reject';
  reason?: string;
}

export const shiftSwapService = {
  create(teamId: string, input: CreateShiftSwapInput): Promise<ShiftSwapResponse> {
    return apiClient.post<ShiftSwapResponse>(`/teams/${teamId}/shift-swaps`, input);
  },

  list(teamId: string, params: ShiftSwapListParams = {}): Promise<ShiftSwapsResponse> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    const queryString = query.toString();
    return apiClient.get<ShiftSwapsResponse>(
      `/teams/${teamId}/shift-swaps${queryString ? `?${queryString}` : ''}`
    );
  },

  respond(
    teamId: string,
    swapId: string,
    input: RespondShiftSwapInput
  ): Promise<ShiftSwapResponse> {
    return apiClient.post<ShiftSwapResponse>(
      `/teams/${teamId}/shift-swaps/${swapId}/respond`,
      input
    );
  },

  review(
    teamId: string,
    swapId: string,
    input: ReviewShiftSwapInput
  ): Promise<ShiftSwapResponse> {
    return apiClient.post<ShiftSwapResponse>(
      `/teams/${teamId}/shift-swaps/${swapId}/review`,
      input
    );
  },

  cancel(teamId: string, swapId: string): Promise<ShiftSwapResponse> {
    return apiClient.post<ShiftSwapResponse>(
      `/teams/${teamId}/shift-swaps/${swapId}/cancel`
    );
  },
};

