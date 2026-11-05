import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { FormField } from '@/components/common/FormField';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import { useCreateTeam, useTeams } from '@/services/query';
import { Team } from '@/types/api';
import { colors, spacing, typography } from '@/constants/theme';

export default function SelectTeamScreen() {
  const router = useRouter();
  const { user, selectedTeam, selectTeam, signOut } = useAuth();
  const {
    data: teamsData,
    isLoading: loading,
    isRefetching: refreshing,
    error: queryError,
    refetch,
  } = useTeams(user?.id);
  const createTeamMutation = useCreateTeam(user?.id);

  const [teamName, setTeamName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const teams = teamsData?.teams ?? [];
  const error =
    localError ||
    (queryError
      ? queryError instanceof ApiError
        ? queryError.message
        : 'Unable to load your teams.'
      : null);

  const choose = async (team: Team) => {
    await selectTeam(team);
    router.replace('/(app)');
  };

  const createTeam = async () => {
    const name = teamName.trim();
    if (!name) {
      setLocalError('Give your team a name first.');
      return;
    }
    setLocalError(null);
    try {
      const response = await createTeamMutation.mutateAsync(name);
      setTeamName('');
      await choose(response.team);
    } catch (requestError) {
      setLocalError(requestError instanceof ApiError ? requestError.message : 'Unable to create the team.');
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setLocalError(null);
            refetch();
          }}
          tintColor={colors.primary}
        />
      }
    >
      <BrandHeader
        badge="TEAMS"
        title="Choose your team"
        subtitle={user?.name ? `Welcome, ${user.name}` : 'Select a workspace to continue'}
      />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Your teams</Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : teams.length === 0 ? (
          <Text style={styles.muted}>You are not part of a team yet. Create your first one below.</Text>
        ) : (
          <View style={styles.teamList}>
            {teams.map((team) => (
              <ActionButton
                key={team.id}
                label={`${team.name}${selectedTeam?.id === team.id ? '  \u2022  Selected' : ''}`}
                onPress={() => choose(team)}
                variant={selectedTeam?.id === team.id ? 'primary' : 'secondary'}
              />
            ))}
          </View>
        )}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Create a team</Text>
        <FormField
          label="Team name"
          value={teamName}
          onChangeText={setTeamName}
          placeholder="The Morning Crew"
          maxLength={100}
        />
        <ActionButton label="Create team" onPress={createTeam} loading={createTeamMutation.isPending} />
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Have an invitation code?</Text>
        <Text style={styles.muted}>If you received an invitation by email or link, you can enter the code to join.</Text>
        <ActionButton label="Enter invitation code" onPress={() => router.push('/invite')} variant="secondary" />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.signOutRow}>
        <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  section: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    marginBottom: spacing.md,
  },
  teamList: { gap: spacing.sm },
  signOutRow: { marginTop: spacing.sm },
  loader: { paddingVertical: spacing.lg },
  muted: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 21,
    marginBottom: spacing.sm,
  },
  error: { color: colors.error, fontSize: typography.sizes.sm, marginBottom: spacing.md },
});
