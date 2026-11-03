import { apiClient } from './apiClient';
import { AuthResult, TokenPair, User } from '@/types/api';

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface PasswordResetRequestInput {
  email: string;
}

export interface PasswordResetRequestResponse {
  message: string;
}

export interface PasswordResetConfirmInput {
  token: string;
  password: string;
}

export interface PasswordResetConfirmResponse {
  message: string;
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

  /**
   * Request self-service password reset email.
   * HTTP Method: POST
   * Path: /auth/password-reset/request
   * Purpose: Sends a password reset email with secure token to the user if an account exists.
   * Authentication: Public (skipAuth=true, allowRefresh=false)
   * Request Body: { email: string }
   */
  requestPasswordReset(input: PasswordResetRequestInput): Promise<PasswordResetRequestResponse> {
    return apiClient.post<PasswordResetRequestResponse>(
      '/auth/password-reset/request',
      input,
      { skipAuth: true, allowRefresh: false }
    );
  },

  /**
   * Confirm password reset with token and new password.
   * HTTP Method: POST
   * Path: /auth/password-reset/confirm
   * Purpose: Updates password with a valid, single-use token and invalidates all existing refresh sessions.
   * Authentication: Public (skipAuth=true, allowRefresh=false)
   * Request Body: { token: string, password: string }
   */
  confirmPasswordReset(input: PasswordResetConfirmInput): Promise<PasswordResetConfirmResponse> {
    return apiClient.post<PasswordResetConfirmResponse>(
      '/auth/password-reset/confirm',
      input,
      { skipAuth: true, allowRefresh: false }
    );
  },
};
