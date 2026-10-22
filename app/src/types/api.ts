export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error';
  data?: T;
  message?: string;
}

export interface HealthCheckResponse {
  status: 'ok';
  message: string;
  timestamp: string;
  uptime: number;
}

export interface ApiErrorResponse {
  status: 'error';
  message: string;
  errors?: Array<{
    field?: string;
    message: string;
  }>;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface Team {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsResponse {
  teams: Team[];
}

export interface TeamResponse {
  team: Team;
}
