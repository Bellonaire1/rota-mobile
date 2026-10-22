import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/context/AuthContext';

export default function AuthLayout() {
  const { user, isLoading } = useAuth();
  if (isLoading || user) return user ? <Redirect href="/(app)" /> : null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
