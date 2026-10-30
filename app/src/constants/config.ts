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
  const isDistributionBuild =
    Constants.executionEnvironment === 'standalone' ||
    (!__DEV__ && (Constants as any).appOwnership !== 'expo');

  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  // Distribution / Standalone APK builds MUST have a valid public HTTPS endpoint.
  if (isDistributionBuild) {
    if (!configuredUrl) {
      throw new Error(
        'Distribution APK build requires an explicitly configured public HTTPS EXPO_PUBLIC_API_URL. Silent fallback to localhost, emulator loopback, or private hotspot IPs is strictly prohibited in standalone builds.'
      );
    }

    if (!configuredUrl.startsWith('https://')) {
      throw new Error(
        `Distribution APK build requires a secure public HTTPS endpoint (e.g. https://your-service.onrender.com/api/v1). Insecure or non-HTTPS URL: "${configuredUrl}"`
      );
    }

    if (
      configuredUrl.includes('localhost') ||
      configuredUrl.includes('127.0.0.1') ||
      configuredUrl.includes('10.0.2.2') ||
      /https:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(configuredUrl)
    ) {
      throw new Error(
        `Distribution APK build cannot target private or local network IP addresses: "${configuredUrl}". A publicly accessible HTTPS host is required.`
      );
    }

    return configuredUrl;
  }

  // Local development / Expo Go: allow explicit override if supplied
  if (configuredUrl) {
    return configuredUrl;
  }

  // Local development: derive host IP when running in Expo Go / dev client
  const hostUri =
    Constants.expoConfig?.hostUri ||
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost ||
    (Constants as any).manifest?.debuggerHost ||
    Constants.experienceUrl;

  if (hostUri && typeof hostUri === 'string') {
    const sanitized = hostUri.replace(/^[a-z]+:\/\//i, '');
    const hostIp = sanitized.split(':')[0]?.split('/')[0];
    if (hostIp && hostIp !== 'localhost' && hostIp !== '127.0.0.1') {
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
