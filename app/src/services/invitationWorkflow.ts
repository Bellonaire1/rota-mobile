/**
 * Core workflow coordinators and state managers for mobile team invitations.
 * Extracted pure logic shared between UI screens and targeted verification suites.
 */

export interface KeyValueStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  isAvailableAsync?(): Promise<boolean>;
}

export interface StoredInvitationPayload {
  token: string;
  savedAt: number;
  forSwitchAccount?: boolean;
}

export const PENDING_INVITATION_STORAGE_KEY = 'rota.pending-invitation-token';
export const DEFAULT_PENDING_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Manages pending invitation token persistence, explicit cancellation,
 * account-switch preservation, and automatic abandonment expiration.
 */
export class PendingTokenManager {
  private storage: KeyValueStorage | null;
  private memoryToken: string | null = null;
  private memorySavedAt = 0;
  private maxAgeMs: number;

  constructor(
    storage: KeyValueStorage | null = null,
    maxAgeMs: number = DEFAULT_PENDING_TOKEN_MAX_AGE_MS
  ) {
    this.storage = storage;
    this.maxAgeMs = maxAgeMs;
  }

  setStorage(storage: KeyValueStorage | null): void {
    this.storage = storage;
  }

  async saveToken(token: string, forSwitchAccount = false): Promise<void> {
    const cleanToken = token.trim();
    const now = Date.now();
    this.memoryToken = cleanToken;
    this.memorySavedAt = now;

    if (this.storage) {
      try {
        const payload: StoredInvitationPayload = {
          token: cleanToken,
          savedAt: now,
          forSwitchAccount,
        };
        await this.storage.setItemAsync(
          PENDING_INVITATION_STORAGE_KEY,
          JSON.stringify(payload)
        );
      } catch {
        // Retain memory fallback if persistent storage fails
      }
    }
  }

  async getToken(): Promise<string | null> {
    const now = Date.now();

    if (this.storage) {
      try {
        const raw = await this.storage.getItemAsync(PENDING_INVITATION_STORAGE_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as StoredInvitationPayload;
            if (parsed && typeof parsed.token === 'string') {
              if (parsed.savedAt && now - parsed.savedAt > this.maxAgeMs) {
                // Token has expired/been abandoned; purge it
                await this.clearToken();
                return null;
              }
              return parsed.token;
            }
          } catch {
            // Backward compatibility with raw token strings
            return raw;
          }
        }
      } catch {
        // Fall through to memory
      }
    }

    if (this.memoryToken) {
      if (this.memorySavedAt && now - this.memorySavedAt > this.maxAgeMs) {
        this.memoryToken = null;
        this.memorySavedAt = 0;
        return null;
      }
      return this.memoryToken;
    }

    return null;
  }

  async clearToken(): Promise<void> {
    this.memoryToken = null;
    this.memorySavedAt = 0;
    if (this.storage) {
      try {
        await this.storage.deleteItemAsync(PENDING_INVITATION_STORAGE_KEY);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  async cancelInvitation(): Promise<void> {
    await this.clearToken();
  }

  async switchAccount(token: string): Promise<void> {
    await this.saveToken(token, true);
  }
}

/**
 * Tracks in-flight preview requests by generation, token, and user identity.
 * Discards stale responses from older requests, account switches, or token switches.
 */
export class PreviewGenerationTracker {
  private generation = 0;
  private currentToken: string | null = null;
  private currentUserId: string | null = null;

  startRequest(token: string, userId?: string | null): number {
    this.generation += 1;
    this.currentToken = token;
    this.currentUserId = userId ?? null;
    return this.generation;
  }

  isCurrent(generation: number, token: string, userId?: string | null): boolean {
    return (
      this.generation === generation &&
      this.currentToken === token &&
      this.currentUserId === (userId ?? null)
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.currentToken = null;
    this.currentUserId = null;
  }

  getGeneration(): number {
    return this.generation;
  }

  getCurrentToken(): string | null {
    return this.currentToken;
  }

  getCurrentUserId(): string | null {
    return this.currentUserId;
  }
}

export interface AcceptAndSyncParams<TTeam> {
  token: string;
  acceptFn: (token: string) => Promise<{ team: { id: string; name: string } }>;
  listTeamsFn: () => Promise<{ teams: TTeam[] }>;
  selectTeamFn: (team: TTeam) => Promise<void>;
  onComplete: () => void;
  getTeamId: (team: TTeam) => string;
}

export interface RetrySyncParams<TTeam> {
  listTeamsFn: () => Promise<{ teams: TTeam[] }>;
  selectTeamFn: (team: TTeam) => Promise<void>;
  onComplete: () => void;
  getTeamId: (team: TTeam) => string;
}

/**
 * Coordinates atomic acceptance and post-acceptance team list synchronization.
 * Enforces submission locks, prohibits fabricated team metadata, and enables
 * dedicated team-sync retry without repeating the already-consumed accept call.
 */
export class InvitationAcceptanceCoordinator<TTeam = any> {
  private isSubmitting = false;
  private acceptedTeamId: string | null = null;
  private acceptedTeamName: string | null = null;
  private syncFailed = false;
  private syncError: string | null = null;

  isAccepting(): boolean {
    return this.isSubmitting;
  }

  getAcceptedTeamId(): string | null {
    return this.acceptedTeamId;
  }

  getAcceptedTeamName(): string | null {
    return this.acceptedTeamName;
  }

  isSyncFailed(): boolean {
    return this.syncFailed;
  }

  getSyncError(): string | null {
    return this.syncError;
  }

  async acceptAndSync(params: AcceptAndSyncParams<TTeam>): Promise<{
    success: boolean;
    accepted: boolean;
    error?: string;
    syncFailed?: boolean;
  }> {
    // Immediate synchronous lock against rapid multi-taps
    if (this.isSubmitting) {
      return { success: false, accepted: !!this.acceptedTeamId, error: 'Submission in progress' };
    }
    this.isSubmitting = true;
    this.syncFailed = false;
    this.syncError = null;

    try {
      // 1. Accept token if not already accepted
      if (!this.acceptedTeamId) {
        const acceptResult = await params.acceptFn(params.token);
        this.acceptedTeamId = acceptResult.team.id;
        this.acceptedTeamName = acceptResult.team.name;
      }

      // 2. Synchronize team list
      return await this.executeSync(
        params.listTeamsFn,
        params.selectTeamFn,
        params.onComplete,
        params.getTeamId
      );
    } catch (err: any) {
      this.isSubmitting = false;
      return {
        success: false,
        accepted: !!this.acceptedTeamId,
        error: err?.message || 'Failed to accept invitation',
      };
    }
  }

  async retrySync(params: RetrySyncParams<TTeam>): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isSubmitting) {
      return { success: false, error: 'Synchronization in progress' };
    }
    if (!this.acceptedTeamId) {
      return { success: false, error: 'No accepted invitation to synchronize' };
    }
    this.isSubmitting = true;
    this.syncFailed = false;
    this.syncError = null;

    return await this.executeSync(
      params.listTeamsFn,
      params.selectTeamFn,
      params.onComplete,
      params.getTeamId
    );
  }

  private async executeSync(
    listTeamsFn: () => Promise<{ teams: TTeam[] }>,
    selectTeamFn: (team: TTeam) => Promise<void>,
    onComplete: () => void,
    getTeamId: (team: TTeam) => string
  ): Promise<{ success: boolean; accepted: true; error?: string; syncFailed?: boolean }> {
    try {
      const { teams } = await listTeamsFn();
      const realTeam = teams.find((t) => getTeamId(t) === this.acceptedTeamId);

      if (!realTeam) {
        this.syncFailed = true;
        this.syncError = 'Your invitation was accepted, but the new team is not yet visible in your team list.';
        this.isSubmitting = false;
        return {
          success: false,
          accepted: true,
          syncFailed: true,
          error: this.syncError,
        };
      }

      // Select real server-returned team
      await selectTeamFn(realTeam);
      this.isSubmitting = false;
      onComplete();
      return { success: true, accepted: true };
    } catch (err: any) {
      this.syncFailed = true;
      this.syncError = err?.message || 'Failed to synchronize your team list.';
      this.isSubmitting = false;
      return {
        success: false,
        accepted: true,
        syncFailed: true,
        error: this.syncError ?? undefined,
      };
    }
  }

  reset(): void {
    this.isSubmitting = false;
    this.acceptedTeamId = null;
    this.acceptedTeamName = null;
    this.syncFailed = false;
    this.syncError = null;
  }
}
