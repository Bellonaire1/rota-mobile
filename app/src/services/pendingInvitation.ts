import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const PENDING_INVITATION_KEY = 'rota.pending-invitation-token';
let memoryFallbackToken: string | null = null;

export const pendingInvitationStorage = {
  async savePendingToken(token: string): Promise<void> {
    const cleanToken = token.trim();
    memoryFallbackToken = cleanToken;
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.setItemAsync(PENDING_INVITATION_KEY, cleanToken);
      }
    } catch {
      // Retain memory fallback if SecureStore fails
    }
  },

  async getPendingToken(): Promise<string | null> {
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        const stored = await SecureStore.getItemAsync(PENDING_INVITATION_KEY);
        if (stored) return stored;
      }
    } catch {
      // Fall through to memory fallback
    }
    return memoryFallbackToken;
  },

  async clearPendingToken(): Promise<void> {
    memoryFallbackToken = null;
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.deleteItemAsync(PENDING_INVITATION_KEY);
      }
    } catch {
      // Ignore cleanup error
    }
  },
};
