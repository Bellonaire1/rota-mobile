import { Shift, ShiftStatus } from '@/types/api';

let secureStoreModule: any = null;
function getSecureStore(): any {
  if (!secureStoreModule) {
    try {
      secureStoreModule = require('expo-secure-store');
    } catch {
      secureStoreModule = null;
    }
  }
  return secureStoreModule;
}

/**
 * Storage adapter interface.
 * Explicitly states whether underlying storage is hardware/OS encrypted.
 */
export interface OfflineStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  isEncrypted(): boolean;
}

/**
 * Minimum data structure stored for offline viewing.
 * Strictly excludes: JWT tokens, refresh tokens, invitation codes,
 * billing secrets, and full user metadata.
 */
export interface CompactOfflineShift {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  assignedToName: string;
  assignedToUserId: string;
}

export interface OfflineShiftSnapshot {
  userId: string;
  teamId: string;
  syncedAt: string; // ISO 8601 string
  shifts: CompactOfflineShift[];
}

/**
 * Key generators scoped strictly to userId AND teamId.
 * Guarantees zero cross-team or cross-account data restoration.
 */
export const getOfflineShiftKey = (userId: string, teamId: string) =>
  `rota.offline-shifts.${userId}.${teamId}`;

/**
 * Registry index key for discovering all teams that have persisted offline data for a user.
 * Enables zero-parameter cleanups on sign-out and account switching.
 */
export const getOfflineTeamIndexKey = (userId: string) =>
  `rota.offline-shifts.index.${userId}`;

/**
 * Production SecureStore adapter.
 * Uses iOS Keychain and Android Keystore with AES-GCM / RSA encrypted SharedPreferences.
 * Assessed as ENCRYPTED: isEncrypted() returns true.
 */
export class SecureStoreAdapter implements OfflineStorageAdapter {
  async getItem(key: string): Promise<string | null> {
    const SecureStore = getSecureStore();
    if (!SecureStore) return null;
    try {
      if (
        typeof SecureStore.isAvailableAsync === 'function' &&
        !(await SecureStore.isAvailableAsync())
      ) {
        return null;
      }
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const SecureStore = getSecureStore();
    if (!SecureStore) throw new Error('SecureStore is not available');
    if (
      typeof SecureStore.isAvailableAsync === 'function' &&
      !(await SecureStore.isAvailableAsync())
    ) {
      throw new Error('SecureStore is not available on this platform');
    }
    await SecureStore.setItemAsync(key, value);
  }

  async removeItem(key: string): Promise<void> {
    const SecureStore = getSecureStore();
    if (!SecureStore) throw new Error('SecureStore is not available');
    if (
      typeof SecureStore.isAvailableAsync === 'function' &&
      !(await SecureStore.isAvailableAsync())
    ) {
      throw new Error('SecureStore is not available on this platform');
    }
    await SecureStore.deleteItemAsync(key);
  }

  isEncrypted(): boolean {
    return true;
  }
}

/**
 * In-memory storage adapter for testing and web fallback.
 * Assessed as NOT hardware encrypted: isEncrypted() returns false.
 */
export class MemoryStorageAdapter implements OfflineStorageAdapter {
  private store = new Map<string, string>();
  private failureMode: {
    set?: boolean | ((key: string) => boolean);
    remove?: boolean | ((key: string) => boolean);
    get?: boolean | ((key: string) => boolean);
  } = {};

  public setFailureMode(mode: {
    set?: boolean | ((key: string) => boolean);
    remove?: boolean | ((key: string) => boolean);
    get?: boolean | ((key: string) => boolean);
  }) {
    this.failureMode = mode;
  }

  async getItem(key: string): Promise<string | null> {
    const shouldFail =
      typeof this.failureMode.get === 'function'
        ? this.failureMode.get(key)
        : this.failureMode.get;
    if (shouldFail) throw new Error(`Simulated storage read error for key: ${key}`);
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    const shouldFail =
      typeof this.failureMode.set === 'function'
        ? this.failureMode.set(key)
        : this.failureMode.set;
    if (shouldFail) throw new Error(`Simulated storage write error for key: ${key}`);
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    const shouldFail =
      typeof this.failureMode.remove === 'function'
        ? this.failureMode.remove(key)
        : this.failureMode.remove;
    if (shouldFail) throw new Error(`Simulated storage delete error for key: ${key}`);
    this.store.delete(key);
  }

  isEncrypted(): boolean {
    return false;
  }
}

/**
 * Maximum number of shifts cached for offline viewing.
 */
export const MAX_OFFLINE_SHIFTS_PER_TEAM = 20;

/**
 * Maximum serialized byte limit for Android SharedPreferences / SecureStore.
 * Enforced via actual measured UTF-8 byte count.
 */
export const MAX_OFFLINE_PAYLOAD_BYTES = 2000;

export function getUtf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  const buf = (globalThis as any).Buffer;
  if (buf && typeof buf.byteLength === 'function') {
    return buf.byteLength(str, 'utf8');
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function truncateText(str: string | undefined | null, maxChars: number): string {
  if (!str) return '';
  const trimmed = str.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export class OfflineShiftStorageManager {
  private adapter: OfflineStorageAdapter;

  constructor(adapter?: OfflineStorageAdapter) {
    this.adapter = adapter ?? new SecureStoreAdapter();
  }

  public getAdapter(): OfflineStorageAdapter {
    return this.adapter;
  }

  /**
   * Compacts, truncates, bounds, and persists shifts for the active team.
   * Enforces exact UTF-8 byte size limit under 2000 bytes.
   */
  async saveShifts(
    userId: string,
    teamId: string,
    shifts: Shift[]
  ): Promise<OfflineShiftSnapshot> {
    if (!userId || !teamId) {
      throw new Error('userId and teamId are required to persist offline shifts');
    }

    let compactShifts: CompactOfflineShift[] = shifts
      .slice(0, MAX_OFFLINE_SHIFTS_PER_TEAM)
      .map((s) => ({
        id: s.id,
        title: truncateText(s.title, 40),
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        assignedToName: truncateText(
          s.assignedTo?.name || s.assignedTo?.email || 'Unassigned',
          30
        ),
        assignedToUserId: s.assignedToUserId,
      }));

    let snapshot: OfflineShiftSnapshot = {
      userId,
      teamId,
      syncedAt: new Date().toISOString(),
      shifts: compactShifts,
    };

    let serialized = JSON.stringify(snapshot);

    // Iteratively drop older shifts if payload exceeds byte size limit
    while (compactShifts.length > 0 && getUtf8ByteLength(serialized) > MAX_OFFLINE_PAYLOAD_BYTES) {
      compactShifts = compactShifts.slice(0, compactShifts.length - 1);
      snapshot = { ...snapshot, shifts: compactShifts };
      serialized = JSON.stringify(snapshot);
    }

    if (getUtf8ByteLength(serialized) > MAX_OFFLINE_PAYLOAD_BYTES) {
      throw new Error(
        `Unable to compress offline shift snapshot within ${MAX_OFFLINE_PAYLOAD_BYTES} bytes limit`
      );
    }

    // 1. Update user's team index FIRST so snapshot is never left untracked
    const indexKey = getOfflineTeamIndexKey(userId);
    const rawIndex = await this.adapter.getItem(indexKey);
    let teams: string[] = [];
    if (rawIndex) {
      try {
        teams = JSON.parse(rawIndex);
      } catch {
        teams = [];
      }
    }
    if (!teams.includes(teamId)) {
      teams.push(teamId);
      await this.adapter.setItem(indexKey, JSON.stringify(teams));
    }

    // 2. Persist shift snapshot
    const key = getOfflineShiftKey(userId, teamId);
    await this.adapter.setItem(key, serialized);

    return snapshot;
  }

  /**
   * Retrieves offline shift snapshot for specific user and team.
   * Never returns data if teamId or userId does not match.
   */
  async getShifts(
    userId: string,
    teamId: string
  ): Promise<OfflineShiftSnapshot | null> {
    if (!userId || !teamId) return null;
    const key = getOfflineShiftKey(userId, teamId);
    const raw = await this.adapter.getItem(key);
    if (!raw) return null;

    try {
      const parsed: OfflineShiftSnapshot = JSON.parse(raw);
      if (parsed.userId !== userId || parsed.teamId !== teamId) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Clears offline shifts for a specific team (e.g. on 403 Forbidden / membership revoked).
   */
  async clearTeamShifts(userId: string, teamId: string): Promise<void> {
    if (!userId || !teamId) return;
    const key = getOfflineShiftKey(userId, teamId);
    await this.adapter.removeItem(key);

    // Remove team from user's index
    try {
      const indexKey = getOfflineTeamIndexKey(userId);
      const rawIndex = await this.adapter.getItem(indexKey);
      if (rawIndex) {
        const teams: string[] = JSON.parse(rawIndex);
        const updated = teams.filter((t) => t !== teamId);
        if (updated.length > 0) {
          await this.adapter.setItem(indexKey, JSON.stringify(updated));
        } else {
          await this.adapter.removeItem(indexKey);
        }
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Discovers and clears all offline shift snapshots for a user across all previously
   * visited teams without requiring caller to guess or pass team IDs.
   * Explicitly detects and reports deletion failures.
   */
  async clearUserShifts(userId: string, knownTeamIds: string[] = []): Promise<void> {
    if (!userId) return;

    const indexKey = getOfflineTeamIndexKey(userId);
    let indexedTeams: string[] = [];
    try {
      const rawIndex = await this.adapter.getItem(indexKey);
      if (rawIndex) {
        indexedTeams = JSON.parse(rawIndex);
      }
    } catch {
      indexedTeams = [];
    }

    const allTeams = Array.from(new Set([...indexedTeams, ...knownTeamIds]));
    const failedTeams: string[] = [];
    const errors: Error[] = [];

    for (const teamId of allTeams) {
      try {
        const key = getOfflineShiftKey(userId, teamId);
        await this.adapter.removeItem(key);
      } catch (err: any) {
        failedTeams.push(teamId);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (failedTeams.length > 0) {
      // Retain failed teams in the index so retry can discover and clean them up
      try {
        await this.adapter.setItem(indexKey, JSON.stringify(failedTeams));
      } catch (err: any) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      try {
        await this.adapter.removeItem(indexKey);
      } catch (err: any) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to clean up offline shifts for user ${userId}: ${errors.map((e) => e.message).join('; ')}`
      );
    }
  }
}

export const offlineShiftStorage = new OfflineShiftStorageManager();
