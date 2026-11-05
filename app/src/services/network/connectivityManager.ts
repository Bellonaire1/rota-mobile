import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

type ConnectivityListener = (isOnline: boolean) => void;

class ConnectivityManager {
  private online = true;
  private listeners = new Set<ConnectivityListener>();

  constructor() {
    this.online = true;
  }

  public isOnline(): boolean {
    return this.online;
  }

  public setOnline(state: boolean): void {
    if (this.online !== state) {
      this.online = state;
      onlineManager.setOnline(state);
      this.listeners.forEach((listener) => listener(state));
    }
  }

  public subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    listener(this.online);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Probes the health endpoint to verify genuine internet access.
   */
  public async checkConnectivity(probeFn?: () => Promise<any>): Promise<boolean> {
    try {
      if (probeFn) {
        await probeFn();
      } else if (typeof fetch === 'function') {
        const url = process.env.EXPO_PUBLIC_API_URL
          ? `${process.env.EXPO_PUBLIC_API_URL}/health`
          : 'http://localhost:5000/api/v1/health';
        await fetch(url);
      }
      this.setOnline(true);
      return true;
    } catch (err: any) {
      if (
        err?.message?.includes('Network request failed') ||
        err?.message?.includes('Failed to fetch') ||
        err?.name === 'TypeError'
      ) {
        this.setOnline(false);
        return false;
      }
      this.setOnline(true);
      return true;
    }
  }
}

export const connectivityManager = new ConnectivityManager();

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
