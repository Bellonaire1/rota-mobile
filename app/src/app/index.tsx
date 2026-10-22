import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/theme';

export default function IndexPage() {
  const { user, selectedTeam, isLoading } = useAuth();
  if (isLoading) return <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>;
  if (!user) return <Redirect href="/(auth)/login" />;
  return <Redirect href={selectedTeam ? '/(app)' : '/(app)/select-team'} />;
}

const styles = StyleSheet.create({ loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' } });
