import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Resolves the backend API base URL dynamically.
 * 
 * Strategy:
 * 1. Explicit override via EXPO_PUBLIC_API_URL environment variable.
 * 2. In local Expo development, inspect Constants.expoConfig?.hostUri to connect
 *    to the host development machine from physical Android / iOS devices on the local network.
 * 3. Android emulator fallback (10.0.2.2).
 * 4. Default localhost fallback (for web or iOS simulator).
 */
const resolveApiBaseUrl = (): string => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  // Derive host IP when running in Expo Go / dev client
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const hostIp = hostUri.split(':')[0];
    if (hostIp) {
      return `http://${hostIp}:5000/api/v1`;
    }
  }

  // Android emulator loopback alias
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:5000/api/v1';
  }

  // Default loopback for web and iOS simulator
  return 'http://localhost:5000/api/v1';
};

export const API_BASE_URL = resolveApiBaseUrl();

export const APP_CONFIG = {
  appName: 'Rota',
  tagline: 'Team scheduling made simple',
  apiVersion: 'v1',
  apiBaseUrl: API_BASE_URL,
} as const;
