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

export type TeamRole = 'OWNER' | 'MANAGER' | 'STAFF';

export interface TeamMember {
  id: string;
  userId: string;
  role: TeamRole;
  createdAt: string;
  updatedAt: string;
  user: Pick<User, 'id' | 'email' | 'name'>;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface TeamMembersResponse {
  members: TeamMember[];
  pagination: Pagination;
}

export type ShiftStatus = 'SCHEDULED' | 'CANCELLED';

export interface Shift {
  id: string;
  teamId: string;
  assignedToUserId: string;
  createdByUserId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  assignedTo: Pick<User, 'id' | 'email' | 'name'>;
  createdBy: Pick<User, 'id' | 'email' | 'name'>;
}

export interface ShiftsResponse {
  shifts: Shift[];
  pagination: Pagination;
}

export interface ShiftResponse {
  shift: Shift;
}
