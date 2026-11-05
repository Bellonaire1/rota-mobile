import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type ConnectivityListener = (isOnline: boolean, backendAvailable: boolean) => void;

function getHealthUrl(): string {
  try {
    const config = require('../../constants/config');
    if (config?.API_BASE_URL) return `${config.API_BASE_URL}/health`;
  } catch {
    // Node test runner fallback without React Native / Expo bindings
  }
  const base = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
  return `${base.replace(/\/$/, '')}/health`;
}

export interface AppStateSource {
  addEventListener: (
    type: any,
    listener: (state: any) => void
  ) => { remove: () => void };
}

export interface NetInfoState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  type?: string;
}

export interface NetInfoSource {
  addEventListener: (listener: (state: NetInfoState) => void) => (() => void) | { remove: () => void };
  fetch?: () => Promise<NetInfoState>;
}

let cachedNetInfo: any = undefined;
function getNetInfo(): any {
  if (cachedNetInfo !== undefined) return cachedNetInfo;
  try {
    const mod = require('@react-native-community/netinfo');
    cachedNetInfo = mod?.default || mod;
  } catch {
    cachedNetInfo = null;
  }
  return cachedNetInfo;
}

export class ConnectivityManager {
  private online = true;
  private backendAvailable = true;
  private listeners = new Set<ConnectivityListener>();
  private checkInFlight: Promise<{ isOnline: boolean; backendAvailable: boolean }> | null = null;
  private lastCheckedAt: number | null = null;

  constructor() {
    this.online = true;
    this.backendAvailable = true;
  }

  public isOnline(): boolean {
    return this.online;
  }

  public isBackendAvailable(): boolean {
    return this.backendAvailable;
  }

  public setOnline(isOnline: boolean, backendAvailable: boolean = isOnline): void {
    const changed = this.online !== isOnline || this.backendAvailable !== backendAvailable;
    this.online = isOnline;
    this.backendAvailable = backendAvailable;

    if (changed) {
      onlineManager.setOnline(isOnline);
      this.listeners.forEach((listener) => listener(isOnline, backendAvailable));
    }
  }

  public subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    listener(this.online, this.backendAvailable);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Probes the health endpoint to verify genuine internet access and server health.
   * Uses AbortController with a 4s timeout. Avoids redundant concurrent in-flight checks.
   */
  public async checkConnectivity(
    probeFn?: () => Promise<{ ok: boolean; status: number }>
  ): Promise<{ isOnline: boolean; backendAvailable: boolean }> {
    if (this.checkInFlight) {
      return this.checkInFlight;
    }

    const checkPromise = (async () => {
      let timeoutId: any = null;
      try {
        if (probeFn) {
          const res = await probeFn();
          const isOnline = true;
          const backendAvailable = res.ok && res.status === 200;
          this.setOnline(isOnline, backendAvailable);
          this.lastCheckedAt = Date.now();
          return { isOnline, backendAvailable };
        }

        if (typeof fetch !== 'function') {
          this.setOnline(true, true);
          return { isOnline: true, backendAvailable: true };
        }

        const healthUrl = getHealthUrl();
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        timeoutId = setTimeout(() => {
          try {
            controller?.abort();
          } catch {
            // Ignore
          }
        }, 4000);
        if (timeoutId && typeof timeoutId.unref === 'function') {
          timeoutId.unref();
        }

        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: controller?.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        const isOnline = true;
        const backendAvailable = res.ok && res.status === 200;
        this.setOnline(isOnline, backendAvailable);
        this.lastCheckedAt = Date.now();
        return { isOnline, backendAvailable };
      } catch (err: any) {
        if (timeoutId) clearTimeout(timeoutId);

        // Network transport failure or timeout indicates offline / disconnected state
        const isNetworkFailure =
          err?.name === 'AbortError' ||
          err?.name === 'TypeError' ||
          err?.message?.includes('Network request failed') ||
          err?.message?.includes('Failed to fetch') ||
          err?.message?.includes('network');

        if (isNetworkFailure) {
          this.setOnline(false, false);
          this.lastCheckedAt = Date.now();
          return { isOnline: false, backendAvailable: false };
        }

        // Other unexpected errors
        this.setOnline(true, false);
        this.lastCheckedAt = Date.now();
        return { isOnline: true, backendAvailable: false };
      }
    })();

    this.checkInFlight = checkPromise;
    try {
      return await checkPromise;
    } finally {
      this.checkInFlight = null;
    }
  }
}

export const connectivityManager = new ConnectivityManager();

/**
 * Registers application lifecycle listeners for network connectivity.
 * Probes at startup, listens to native NetInfo network transitions, and handles AppState transitions.
 */
export function setupNetworkConnectivity(
  appStateSource?: AppStateSource,
  netInfoSource?: NetInfoSource,
  options?: { skipInitialProbe?: boolean }
): () => void {
  const cleanups: (() => void)[] = [];

  // 1. Native NetInfo listener (real-time airplane mode / wifi toggle)
  const netInfo = netInfoSource !== undefined ? netInfoSource : getNetInfo();
  if (netInfo && typeof netInfo.addEventListener === 'function') {
    const unsub = netInfo.addEventListener((state: NetInfoState) => {
      const isConnected = state?.isConnected ?? false;
      const isInternetReachable = state?.isInternetReachable;

      if (!isConnected) {
        // Device is offline immediately without waiting for probe timeout
        connectivityManager.setOnline(false, false);
      } else if (isInternetReachable === false) {
        // Local connection but no internet reachability
        connectivityManager.setOnline(false, false);
      } else {
        // Device is connected, verify backend connectivity
        connectivityManager.checkConnectivity().catch(() => {});
      }
    });

    if (typeof unsub === 'function') {
      cleanups.push(unsub);
    } else if (unsub && typeof (unsub as any).remove === 'function') {
      cleanups.push(() => (unsub as any).remove());
    }

    if (typeof netInfo.fetch === 'function') {
      netInfo.fetch().then((state: NetInfoState) => {
        if (state && state.isConnected === false) {
          connectivityManager.setOnline(false, false);
        }
      }).catch(() => {});
    }
  }

  // 2. Initial real probe at startup
  if (!options?.skipInitialProbe) {
    connectivityManager.checkConnectivity().catch(() => {});
  }

  // 3. React Native AppState listener
  if (appStateSource) {
    const sub = appStateSource.addEventListener('change', (nextState: any) => {
      if (nextState === 'active') {
        connectivityManager.checkConnectivity().catch(() => {});
      }
    });
    cleanups.push(() => sub.remove());
  }

  // 4. Web window online / offline listeners
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onOnline = () => connectivityManager.checkConnectivity().catch(() => {});
    const onOffline = () => connectivityManager.setOnline(false, false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    cleanups.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  }

  return () => {
    cleanups.forEach((c) => c());
  };
}

/**
 * React hook exposing live online/offline state.
 */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(connectivityManager.isOnline());

  useEffect(() => {
    return connectivityManager.subscribe((state) => {
      setOnline(state);
    });
  }, []);

  return online;
}

/**
 * React hook exposing live connectivity & backend health state.
 */
export function useConnectivity(): { isOnline: boolean; backendAvailable: boolean } {
  const [state, setState] = useState({
    isOnline: connectivityManager.isOnline(),
    backendAvailable: connectivityManager.isBackendAvailable(),
  });

  useEffect(() => {
    return connectivityManager.subscribe((isOnline, backendAvailable) => {
      setState({ isOnline, backendAvailable });
    });
  }, []);

  return state;
}
