import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/context/AuthContext';
import { queryClient, setupQueryFocusManager } from '@/services/query';
import { setupNetworkConnectivity } from '@/services/network/connectivityManager';

export default function RootLayout() {
  useEffect(() => {
    const teardownFocus = setupQueryFocusManager(AppState, Platform.OS !== 'web');
    const teardownConnectivity = setupNetworkConnectivity(AppState);
    return () => {
      teardownFocus();
      teardownConnectivity();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false }} />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
