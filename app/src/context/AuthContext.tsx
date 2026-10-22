import * as SecureStore from 'expo-secure-store';
import React, { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { apiClient } from '@/services/api/apiClient';
import { authService } from '@/services/api/authService';
import { teamService } from '@/services/api/teamService';
import { Team, User } from '@/types/api';

const refreshTokenKey = (userId: string) => `rota.refresh-token.${userId}`;
const selectedTeamKey = (userId: string) => `rota.selected-team.${userId}`;

interface AuthContextValue {
  user: User | null;
  selectedTeam: Team | null;
  isLoading: boolean;
  isPersistenceAvailable: boolean;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, name: string, password: string): Promise<void>;
  selectTeam(team: Team): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPersistenceAvailable, setIsPersistenceAvailable] = useState(false);
  const refreshTokenRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const persistenceAvailableRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const userRef = useRef<User | null>(null);

  const persistRefreshToken = useCallback(async (userId: string, token: string) => {
    refreshTokenRef.current = token;
    if (persistenceAvailableRef.current) {
      await SecureStore.setItemAsync(refreshTokenKey(userId), token);
    }
  }, []);

  const clearCredentials = useCallback(async (storedUserId?: string) => {
    const currentUser = userRef.current;
    const userId = currentUser?.id ?? storedUserId;
    refreshTokenRef.current = null;
    apiClient.setAccessToken(null);
    userRef.current = null;
    setUser(null);
    setSelectedTeam(null);
    if (persistenceAvailableRef.current && userId) {
      await SecureStore.deleteItemAsync(refreshTokenKey(userId));
      await SecureStore.deleteItemAsync(selectedTeamKey(userId));
    }
  }, []);

  const refreshSession = useCallback(async (storedUserId?: string): Promise<string | null> => {
    if (!refreshTokenRef.current) return null;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    refreshInFlightRef.current = authService
      .refresh(refreshTokenRef.current)
      .then(async (tokens) => {
        apiClient.setAccessToken(tokens.accessToken);
        const userId = userRef.current?.id ?? storedUserId;
        if (userId) {
          await persistRefreshToken(userId, tokens.refreshToken);
        }
        return tokens.accessToken;
      })
      .catch(async () => {
        await clearCredentials(storedUserId);
        return null;
      })
      .finally(() => {
        refreshInFlightRef.current = null;
      });

    return refreshInFlightRef.current;
  }, [clearCredentials, persistRefreshToken]);

  const applyAuthResult = useCallback(async (result: { user: User; accessToken: string; refreshToken: string }) => {
    userRef.current = result.user;
    setUser(result.user);
    apiClient.setAccessToken(result.accessToken);
    await persistRefreshToken(result.user.id, result.refreshToken);
  }, [persistRefreshToken]);

  const restoreSelectedTeam = useCallback(async (restoredUser: User) => {
    try {
      const [{ teams }, persistedTeamId] = await Promise.all([
        teamService.list(),
        persistenceAvailableRef.current
          ? SecureStore.getItemAsync(selectedTeamKey(restoredUser.id))
          : Promise.resolve(null),
      ]);
      const restoredTeam = teams.find((team) => team.id === persistedTeamId);
      setSelectedTeam(restoredTeam ?? null);
    } catch {
      setSelectedTeam(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const restore = async () => {
      const persistenceAvailable = Platform.OS !== 'web' && await SecureStore.isAvailableAsync();
      if (!active) return;
      persistenceAvailableRef.current = persistenceAvailable;
      setIsPersistenceAvailable(persistenceAvailable);
      if (!persistenceAvailable) {
        setIsLoading(false);
        return;
      }

      const storedUserId = await SecureStore.getItemAsync('rota.last-user-id');
      if (!storedUserId) {
        setIsLoading(false);
        return;
      }
      const storedRefreshToken = await SecureStore.getItemAsync(refreshTokenKey(storedUserId));
      if (!storedRefreshToken) {
        setIsLoading(false);
        return;
      }
      refreshTokenRef.current = storedRefreshToken;
      const accessToken = await refreshSession(storedUserId);
      if (!active || !accessToken) {
        setIsLoading(false);
        return;
      }
      try {
        const result = await authService.me();
        userRef.current = result.user;
        setUser(result.user);
        await restoreSelectedTeam(result.user);
      } catch {
        await clearCredentials(storedUserId);
      } finally {
        if (active) setIsLoading(false);
      }
    };
    restore();
    return () => { active = false; };
  }, [clearCredentials, refreshSession, restoreSelectedTeam]);

  useEffect(() => {
    apiClient.setRefreshHandler(refreshSession);
    return () => apiClient.setRefreshHandler(null);
  }, [refreshSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await authService.login({ email, password });
    await applyAuthResult(result);
    if (persistenceAvailableRef.current) await SecureStore.setItemAsync('rota.last-user-id', result.user.id);
    setSelectedTeam(null);
  }, [applyAuthResult]);

  const register = useCallback(async (email: string, name: string, password: string) => {
    const result = await authService.register({ email, name, password });
    await applyAuthResult(result);
    if (persistenceAvailableRef.current) await SecureStore.setItemAsync('rota.last-user-id', result.user.id);
    setSelectedTeam(null);
  }, [applyAuthResult]);

  const selectTeam = useCallback(async (team: Team) => {
    if (!userRef.current) return;
    setSelectedTeam(team);
    if (persistenceAvailableRef.current) {
      await SecureStore.setItemAsync(selectedTeamKey(userRef.current.id), team.id);
    }
  }, []);

  const signOut = useCallback(async () => {
    const token = refreshTokenRef.current;
    try {
      if (token) await authService.logout(token);
    } catch {
      // Local credentials must still be cleared when the server is unreachable.
    } finally {
      await clearCredentials();
      if (persistenceAvailableRef.current) await SecureStore.deleteItemAsync('rota.last-user-id');
    }
  }, [clearCredentials]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    selectedTeam,
    isLoading,
    isPersistenceAvailable,
    signIn,
    register,
    selectTeam,
    signOut,
  }), [isLoading, isPersistenceAvailable, register, selectedTeam, selectTeam, signIn, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
