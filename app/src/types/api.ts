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

export type ShiftSwapStatus =
  | 'PENDING_PEER'
  | 'PENDING_MANAGER'
  | 'APPROVED'
  | 'REJECTED'
  | 'DECLINED'
  | 'CANCELLED';

export interface ShiftSwapShiftSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  assignedToUserId: string;
  assignedTo: Pick<User, 'id' | 'email' | 'name'>;
}

export interface ShiftSwapUserSummary {
  id: string;
  email: string;
  name: string | null;
}

export interface ShiftSwap {
  id: string;
  teamId: string;
  sourceShiftId: string;
  targetShiftId: string;
  requestingUserId: string;
  receivingUserId: string;
  sourceShiftUpdatedAt: string;
  targetShiftUpdatedAt: string;
  status: ShiftSwapStatus;
  peerRespondedAt: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  sourceShift: ShiftSwapShiftSummary;
  targetShift: ShiftSwapShiftSummary;
  requestingUser: ShiftSwapUserSummary;
  receivingUser: ShiftSwapUserSummary;
  reviewedByUser: ShiftSwapUserSummary | null;
}

export interface ShiftSwapResponse {
  shiftSwap: ShiftSwap;
}

export interface ShiftSwapsResponse {
  shiftSwaps: ShiftSwap[];
  pagination: Pagination;
}

export type ActivityEventType =
  | 'SHIFT_CREATED'
  | 'SHIFT_UPDATED'
  | 'SHIFT_CANCELLED'
  | 'MEMBER_ADDED'
  | 'MEMBER_ROLE_CHANGED'
  | 'MEMBER_REMOVED'
  | 'SWAP_REQUESTED'
  | 'SWAP_PEER_ACCEPTED'
  | 'SWAP_PEER_DECLINED'
  | 'SWAP_APPROVED'
  | 'SWAP_REJECTED'
  | 'SWAP_CANCELLED';

export interface ActivityActorSummary {
  id: string;
  name: string | null;
  email: string;
}

export interface ActivityEvent {
  id: string;
  teamId: string;
  actorUserId: string | null;
  type: ActivityEventType;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: ActivityActorSummary | null;
}

export interface ActivityCursorPagination {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ActivityFeedResponse {
  events: ActivityEvent[];
  pagination: ActivityCursorPagination;
}

export interface ActivityFeedQuery {
  limit?: number;
  cursor?: string;
}
