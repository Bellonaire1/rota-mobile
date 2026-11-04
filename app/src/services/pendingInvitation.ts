import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { KeyValueStorage, PendingTokenManager } from './invitationWorkflow';

const secureStoreAdapter: KeyValueStorage = {
  async getItemAsync(key: string): Promise<string | null> {
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (!isAvailable) return null;
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.setItemAsync(key, value);
      }
    } catch {
      // Ignore write failure
    }
  },
  async deleteItemAsync(key: string): Promise<void> {
    try {
      const isAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
      if (isAvailable) {
        await SecureStore.deleteItemAsync(key);
      }
    } catch {
      // Ignore delete failure
    }
  },
  async isAvailableAsync(): Promise<boolean> {
    try {
      return Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());
    } catch {
      return false;
    }
  },
};

export const pendingTokenManager = new PendingTokenManager(secureStoreAdapter);

export const pendingInvitationStorage = {
  savePendingToken: (token: string) => pendingTokenManager.saveToken(token),
  getPendingToken: () => pendingTokenManager.getToken(),
  clearPendingToken: () => pendingTokenManager.clearToken(),
  cancelInvitation: () => pendingTokenManager.cancelInvitation(),
  switchAccount: (token: string) => pendingTokenManager.switchAccount(token),
};
