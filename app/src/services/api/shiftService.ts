import { apiClient } from './apiClient';
import { ShiftResponse, ShiftsResponse } from '@/types/api';

export interface ShiftListParams {
  page?: number;
  limit?: number;
  status?: 'SCHEDULED' | 'CANCELLED';
  from?: string;
  to?: string;
}

export interface CreateShiftInput {
  title: string;
  assignedToUserId: string;
  startsAt: string;
  endsAt: string;
}

export interface UpdateShiftInput extends Partial<CreateShiftInput> {
  updatedAt: string;
}

export const shiftService = {
  list(teamId: string, params: ShiftListParams = {}): Promise<ShiftsResponse> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const queryString = query.toString();
    return apiClient.get<ShiftsResponse>(`/teams/${teamId}/shifts${queryString ? `?${queryString}` : ''}`);
  },

  create(teamId: string, input: CreateShiftInput): Promise<ShiftResponse> {
    return apiClient.post<ShiftResponse>(`/teams/${teamId}/shifts`, input);
  },

  update(teamId: string, shiftId: string, input: UpdateShiftInput): Promise<ShiftResponse> {
    return apiClient.patch<ShiftResponse>(`/teams/${teamId}/shifts/${shiftId}`, input);
  },

  cancel(teamId: string, shiftId: string, updatedAt: string): Promise<ShiftResponse> {
    return apiClient.post<ShiftResponse>(`/teams/${teamId}/shifts/${shiftId}/cancel`, { updatedAt });
  },
};
