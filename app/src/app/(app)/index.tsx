import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { useAuth } from '@/context/AuthContext';
import { colors, spacing, typography } from '@/constants/theme';

export default function DashboardScreen() {
  const router = useRouter();
  const { user, selectedTeam, signOut, isPersistenceAvailable } = useAuth();

  if (!selectedTeam) {
    router.replace('/(app)/select-team');
    return null;
  }

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <BrandHeader title={selectedTeam.name} subtitle={`Good to see you, ${user?.name ?? 'there'}`} />
        <View style={styles.teamPill}><Text style={styles.teamPillLabel}>ACTIVE TEAM</Text><Text style={styles.teamPillName}>{selectedTeam.name}</Text></View>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderEyebrow}>NEXT UP</Text>
          <Text style={styles.placeholderTitle}>Your schedule is coming here.</Text>
          <Text style={styles.placeholderBody}>Task 4B will bring the team schedule, shifts, and daily rhythm into this space.</Text>
        </View>
        {!isPersistenceAvailable ? <Text style={styles.notice}>Secure session persistence is unavailable on this platform. You will need to sign in again after closing the app.</Text> : null}
        <ActionButton label="Change team" onPress={() => router.push('/(app)/select-team')} variant="secondary" />
        <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
  teamPill: { backgroundColor: '#EEF2FF', borderRadius: 16, padding: spacing.md, marginBottom: spacing.md },
  teamPillLabel: { color: colors.primaryLight, fontSize: typography.sizes.xs, fontWeight: '800', letterSpacing: 1 },
  teamPillName: { color: colors.primaryDark, fontSize: typography.sizes.lg, fontWeight: '800', marginTop: spacing.xs },
  placeholder: { backgroundColor: colors.card, borderRadius: 20, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, marginBottom: spacing.md },
  placeholderEyebrow: { color: colors.accent, fontSize: typography.sizes.xs, fontWeight: '800', letterSpacing: 1.2 },
  placeholderTitle: { color: colors.text, fontSize: typography.sizes.xl, fontWeight: '800', marginTop: spacing.sm },
  placeholderBody: { color: colors.textSecondary, fontSize: typography.sizes.md, lineHeight: 24, marginTop: spacing.sm },
  notice: { color: colors.textSecondary, fontSize: typography.sizes.xs, lineHeight: 18, textAlign: 'center', marginBottom: spacing.md },
});
