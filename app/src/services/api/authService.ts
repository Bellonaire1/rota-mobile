import { apiClient } from './apiClient';
import { AuthResult, TokenPair, User } from '@/types/api';

interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

export const authService = {
  register(input: RegisterInput): Promise<AuthResult> {
    return apiClient.post<AuthResult>('/auth/register', input, { skipAuth: true });
  },

  login(input: LoginInput): Promise<AuthResult> {
    return apiClient.post<AuthResult>('/auth/login', input, { skipAuth: true });
  },

  refresh(refreshToken: string): Promise<TokenPair> {
    return apiClient.post<TokenPair>(
      '/auth/refresh',
      { refreshToken },
      { skipAuth: true, allowRefresh: false }
    );
  },

  me(): Promise<{ user: User }> {
    return apiClient.get<{ user: User }>('/auth/me');
  },

  logout(refreshToken: string): Promise<{ message: string }> {
    return apiClient.post<{ message: string }>(
      '/auth/logout',
      { refreshToken },
      { skipAuth: true, allowRefresh: false }
    );
  },
};
