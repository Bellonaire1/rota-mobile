import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { FormField } from '@/components/common/FormField';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import { teamService } from '@/services/api/teamService';
import { Team } from '@/types/api';
import { colors, spacing, typography } from '@/constants/theme';

export default function SelectTeamScreen() {
  const router = useRouter();
  const { user, selectedTeam, selectTeam, signOut } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamName, setTeamName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setError(null);
    try {
      const response = await teamService.list();
      setTeams(response.teams);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to load your teams.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadTeams(); }, [loadTeams]);

  const choose = async (team: Team) => {
    await selectTeam(team);
    router.replace('/(app)');
  };

  const createTeam = async () => {
    const name = teamName.trim();
    if (!name) {
      setError('Give your team a name first.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const response = await teamService.create(name);
      setTeamName('');
      await choose(response.team);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to create the team.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadTeams(); }} tintColor={colors.primary} />}>
      <BrandHeader title="Choose your team" subtitle={user?.name ? `Welcome, ${user.name}` : 'Select a workspace to continue'} />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Your teams</Text>
        {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : teams.length === 0 ? <Text style={styles.muted}>You are not part of a team yet. Create your first one below.</Text> : teams.map((team) => (
          <ActionButton key={team.id} label={`${team.name}${selectedTeam?.id === team.id ? '  •  Selected' : ''}`} onPress={() => choose(team)} variant={selectedTeam?.id === team.id ? 'primary' : 'secondary'} />
        ))}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Create a team</Text>
        <FormField label="Team name" value={teamName} onChangeText={setTeamName} placeholder="The Morning Crew" maxLength={100} />
        <ActionButton label="Create team" onPress={createTeam} loading={creating} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  section: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { color: colors.text, fontSize: typography.sizes.lg, fontWeight: '800', marginBottom: spacing.md },
  loader: { paddingVertical: spacing.lg },
  muted: { color: colors.textSecondary, fontSize: typography.sizes.sm, lineHeight: 21, marginBottom: spacing.sm },
  error: { color: colors.error, fontSize: typography.sizes.sm, marginBottom: spacing.md },
});
