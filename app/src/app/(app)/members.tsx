import * as Clipboard from 'expo-clipboard';
import { Redirect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { FormField } from '@/components/common/FormField';
import { colors, spacing, typography } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import { teamService } from '@/services/api/teamService';
import { TeamMember, TeamRole } from '@/types/api';

type ManagedRole = Exclude<TeamRole, 'OWNER'>;

const memberName = (member: TeamMember) => member.user.name || 'Unnamed member';

export default function MembersScreen() {
  const router = useRouter();
  const { user, selectedTeam, signOut } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [role, setRole] = useState<TeamRole | null>(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const pageRef = useRef(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState('');
  const [newRole, setNewRole] = useState<ManagedRole>('STAFF');
  const [adding, setAdding] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isOwner = role === 'OWNER';
  const hasMore = pagination.page < pagination.totalPages;

  const loadMembers = useCallback(async (reset = true) => {
    if (!selectedTeam || !user) return;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const page = reset ? 1 : pageRef.current + 1;
      const response = await teamService.listMembers(selectedTeam.id, page, 20);
      setMembers((current) => reset ? response.members : [...current, ...response.members]);
      pageRef.current = response.pagination.page;
      setPagination({ page: response.pagination.page, totalPages: response.pagination.totalPages });

      if (reset) {
        let currentMember = response.members.find((member) => member.userId === user.id);
        if (!currentMember && response.pagination.totalPages > 1) {
          const allMembers = await teamService.listAllMembers(selectedTeam.id);
          currentMember = allMembers.find((member) => member.userId === user.id);
        }
        setRole(currentMember?.role ?? null);
      }
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to load team members.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [selectedTeam, user]);

  useEffect(() => { loadMembers(true); }, [loadMembers]);

  const addMember = async () => {
    const userId = userIdInput.trim();
    if (!selectedTeam) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      setError('Enter the registered user’s full UUID.');
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await teamService.addMember(selectedTeam.id, userId, newRole);
      setUserIdInput('');
      await loadMembers(true);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to add this registered user.');
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (member: TeamMember) => {
    if (!selectedTeam || member.role === 'OWNER') return;
    const nextRole: ManagedRole = member.role === 'STAFF' ? 'MANAGER' : 'STAFF';
    setBusyMemberId(member.userId);
    setError(null);
    try {
      await teamService.updateMemberRole(selectedTeam.id, member.userId, nextRole);
      await loadMembers(true);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to change this member’s role.');
    } finally {
      setBusyMemberId(null);
    }
  };

  const removeMember = (member: TeamMember) => {
    if (!selectedTeam || member.role === 'OWNER') return;
    Alert.alert('Remove member?', `Remove ${memberName(member)} from ${selectedTeam.name}?`, [
      { text: 'Keep member', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBusyMemberId(member.userId);
          setError(null);
          try {
            await teamService.removeMember(selectedTeam.id, member.userId);
            await loadMembers(true);
          } catch (requestError) {
            setError(requestError instanceof ApiError ? requestError.message : 'Unable to remove this member.');
          } finally {
            setBusyMemberId(null);
          }
        },
      },
    ]);
  };

  const copyUserId = async () => {
    if (!user) return;
    try {
      await Clipboard.setStringAsync(user.id);
      setCopied(true);
    } catch {
      setError('Unable to copy your user ID. You can select it manually.');
    }
  };

  if (!selectedTeam) return <Redirect href="/(app)/select-team" />;
  if (!user) return <Redirect href="/(auth)/login" />;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadMembers(true); }} tintColor={colors.primary} />}
    >
      <BrandHeader title={selectedTeam.name} subtitle="Team members" />
      <View style={styles.navigationRow}>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/(app)')}><Text style={styles.navLink}>Schedule</Text></Pressable>
        <Text style={styles.navDivider}>·</Text>
        <Text style={styles.navCurrent}>Members</Text>
      </View>

      <View style={styles.identityCard}>
        <Text style={styles.eyebrow}>YOUR REGISTERED USER ID</Text>
        <Text selectable style={styles.userId}>{user.id}</Text>
        <Text style={styles.muted}>Share this ID with a team owner so they can add your existing account. This does not send an invitation.</Text>
        <ActionButton label={copied ? 'Copied' : 'Copy user ID'} onPress={copyUserId} variant="secondary" />
      </View>

      {isOwner ? (
        <View style={styles.manageCard}>
          <Text style={styles.sectionTitle}>Add an existing user</Text>
          <Text style={styles.muted}>Enter the full UUID of a registered Rota user. New owners cannot be assigned here.</Text>
          <FormField label="Registered user ID" value={userIdInput} onChangeText={setUserIdInput} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.formLabel}>Role</Text>
          <View style={styles.roleRow}>
            {(['STAFF', 'MANAGER'] as ManagedRole[]).map((candidate) => (
              <Pressable key={candidate} accessibilityRole="radio" accessibilityState={{ checked: newRole === candidate }} onPress={() => setNewRole(candidate)} style={[styles.roleOption, newRole === candidate && styles.roleSelected]}>
                <Text style={[styles.roleOptionText, newRole === candidate && styles.roleSelectedText]}>{candidate}</Text>
              </Pressable>
            ))}
          </View>
          <ActionButton label="Add registered user" onPress={addMember} loading={adding} />
        </View>
      ) : null}

      <View style={styles.listHeader}>
        <View>
          <Text style={styles.sectionTitle}>People on this team</Text>
          <Text style={styles.muted}>{role ? `You are a ${role.toLowerCase()}.` : 'Your membership role is unavailable.'}</Text>
        </View>
        <Text style={styles.count}>{pagination.page === 1 ? members.length : '…'}</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : members.length === 0 ? (
        <View style={styles.emptyCard}><Text style={styles.emptyTitle}>No members found</Text><Text style={styles.muted}>Refresh and try again.</Text></View>
      ) : members.map((member) => (
        <View key={member.userId} style={styles.memberCard}>
          <View style={styles.memberHeader}>
            <View style={styles.memberIdentity}>
              <Text style={styles.memberName}>{memberName(member)}</Text>
              <Text style={styles.memberEmail}>{member.user.email}</Text>
            </View>
            <Text style={[styles.roleBadge, member.role === 'OWNER' && styles.ownerBadge]}>{member.role}</Text>
          </View>
          {isOwner && member.role !== 'OWNER' ? (
            <View style={styles.memberActions}>
              <ActionButton label={busyMemberId === member.userId ? 'Saving…' : member.role === 'STAFF' ? 'Make manager' : 'Make staff'} onPress={() => changeRole(member)} loading={busyMemberId === member.userId} variant="secondary" />
              <ActionButton label="Remove" onPress={() => removeMember(member)} disabled={busyMemberId !== null} variant="quiet" />
            </View>
          ) : member.role === 'OWNER' ? <Text style={styles.ownerNote}>Owners cannot be changed or removed.</Text> : null}
        </View>
      ))}
      {hasMore ? <ActionButton label={loadingMore ? 'Loading…' : 'Load more members'} onPress={() => loadMembers(false)} loading={loadingMore} variant="secondary" /> : null}

      <ActionButton label="Change team" onPress={() => router.push('/(app)/select-team')} variant="secondary" />
      <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  navigationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md },
  navLink: { color: colors.primary, fontSize: typography.sizes.sm, fontWeight: '700' },
  navCurrent: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '800' },
  navDivider: { color: colors.border, fontSize: typography.sizes.md },
  eyebrow: { color: colors.accent, fontSize: typography.sizes.xs, fontWeight: '800', letterSpacing: 1.2 },
  identityCard: { backgroundColor: '#EEF2FF', borderRadius: 18, padding: spacing.md, marginBottom: spacing.md },
  userId: { color: colors.primaryDark, fontSize: typography.sizes.sm, fontWeight: '800', marginVertical: spacing.sm },
  manageCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: spacing.md, marginBottom: spacing.lg },
  sectionTitle: { color: colors.text, fontSize: typography.sizes.lg, fontWeight: '800' },
  muted: { color: colors.textSecondary, fontSize: typography.sizes.sm, lineHeight: 21, marginVertical: spacing.sm },
  formLabel: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700', marginBottom: spacing.xs },
  roleRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  roleOption: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: spacing.sm, alignItems: 'center', backgroundColor: colors.background },
  roleSelected: { borderColor: colors.primary, backgroundColor: '#EEF2FF' },
  roleOptionText: { color: colors.textSecondary, fontSize: typography.sizes.sm, fontWeight: '700' },
  roleSelectedText: { color: colors.primary },
  listHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: spacing.sm },
  count: { color: colors.textSecondary, fontSize: typography.sizes.sm, fontWeight: '700' },
  memberCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: spacing.md, marginBottom: spacing.sm },
  memberHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  memberIdentity: { flex: 1 },
  memberName: { color: colors.text, fontSize: typography.sizes.md, fontWeight: '800' },
  memberEmail: { color: colors.textSecondary, fontSize: typography.sizes.sm, marginTop: spacing.xs },
  roleBadge: { color: colors.primary, backgroundColor: '#DBEAFE', borderRadius: 8, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: typography.sizes.xs, fontWeight: '800' },
  ownerBadge: { color: '#92400E', backgroundColor: '#FEF3C7' },
  ownerNote: { color: colors.textSecondary, fontSize: typography.sizes.xs, marginTop: spacing.md },
  memberActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loader: { marginVertical: spacing.xl },
  emptyCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: spacing.lg, marginBottom: spacing.md },
  emptyTitle: { color: colors.text, fontSize: typography.sizes.lg, fontWeight: '800' },
  error: { color: colors.error, fontSize: typography.sizes.sm, lineHeight: 20, marginBottom: spacing.md },
});
