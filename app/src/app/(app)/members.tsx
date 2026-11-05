import * as Clipboard from 'expo-clipboard';
import { Redirect, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { FormField } from '@/components/common/FormField';
import { colors, spacing, typography } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import {
  useAddMember,
  useCreateInvitation,
  useRemoveMember,
  useRevokeInvitation,
  useTeamAllMembers,
  useTeamInvitations,
  useTeamMembers,
  useUpdateMemberRole,
} from '@/services/query';
import { TeamInvitation, TeamMember, TeamRole } from '@/types/api';

type ManagedRole = Exclude<TeamRole, 'OWNER'>;

const memberName = (member: TeamMember) => member.user.name || 'Unnamed member';

export default function MembersScreen() {
  const router = useRouter();
  const { user, selectedTeam, signOut } = useAuth();

  const [page, setPage] = useState(1);
  const [accumulatedMembers, setAccumulatedMembers] = useState<TeamMember[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState('');
  const [newRole, setNewRole] = useState<ManagedRole>('STAFF');
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ManagedRole>('STAFF');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Reset page and accumulated list when selectedTeam changes
  useEffect(() => {
    setPage(1);
    setAccumulatedMembers([]);
    setLocalError(null);
  }, [selectedTeam?.id]);

  // Paginated members query for current page
  const {
    data: membersPageData,
    isLoading: loadingMembers,
    isRefetching: refreshingMembers,
    error: membersQueryError,
    refetch: refetchMembers,
  } = useTeamMembers(selectedTeam?.id, user?.id, page, 20);

  // All members query used for role discovery if member isn't in page 1
  const { data: allMembersData } = useTeamAllMembers(selectedTeam?.id, user?.id);

  // Determine user's role in the team
  const userRole: TeamRole | null =
    membersPageData?.members.find((m) => m.userId === user?.id)?.role ??
    allMembersData?.find((m) => m.userId === user?.id)?.role ??
    null;

  const isOwner = userRole === 'OWNER';

  // Invitations query (enabled only for owner)
  const {
    data: invitationsData,
    isLoading: loadingInvitations,
    refetch: refetchInvitations,
  } = useTeamInvitations(selectedTeam?.id, user?.id, isOwner);

  const invitations = invitationsData ?? [];

  // Mutations
  const addMemberMutation = useAddMember(selectedTeam?.id, user?.id);
  const updateMemberRoleMutation = useUpdateMemberRole(selectedTeam?.id, user?.id);
  const removeMemberMutation = useRemoveMember(selectedTeam?.id, user?.id);
  const createInvitationMutation = useCreateInvitation(selectedTeam?.id, user?.id);
  const revokeInvitationMutation = useRevokeInvitation(selectedTeam?.id, user?.id);

  // Synchronize members page data into accumulated list
  useEffect(() => {
    if (!membersPageData) return;
    if (page === 1) {
      setAccumulatedMembers(membersPageData.members);
    } else {
      setAccumulatedMembers((current) => {
        const existingIds = new Set(current.map((m) => m.userId));
        const newMembers = membersPageData.members.filter((m) => !existingIds.has(m.userId));
        return [...current, ...newMembers];
      });
    }
  }, [membersPageData, page]);

  const totalPages = membersPageData?.pagination.totalPages ?? 1;
  const hasMore = page < totalPages;

  const error =
    localError ||
    (membersQueryError
      ? membersQueryError instanceof ApiError
        ? membersQueryError.message
        : 'Unable to load team members.'
      : null);

  const handleRefresh = async () => {
    setLocalError(null);
    setPage(1);
    await refetchMembers();
    if (isOwner) {
      await refetchInvitations();
    }
  };

  const loadMore = () => {
    if (hasMore && !loadingMembers) {
      setPage((p) => p + 1);
    }
  };

  const sendInvitation = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!selectedTeam) return;
    if (!email || !email.includes('@')) {
      setInviteError('Enter a valid email address.');
      return;
    }
    setInviteError(null);
    setInviteSuccess(null);
    try {
      await createInvitationMutation.mutateAsync({
        email,
        role: inviteRole,
      });
      setInviteEmail('');
      setInviteSuccess(`Invitation sent to ${email}`);
    } catch (requestError) {
      setInviteError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Unable to send invitation.'
      );
    }
  };

  const revokeInvitation = (invitation: TeamInvitation) => {
    if (!selectedTeam) return;
    Alert.alert(
      'Revoke invitation?',
      `Revoke invitation for ${invitation.invitedEmail}?`,
      [
        { text: 'Keep invitation', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setRevokingId(invitation.id);
            try {
              await revokeInvitationMutation.mutateAsync(invitation.id);
            } catch (requestError) {
              setLocalError(
                requestError instanceof ApiError
                  ? requestError.message
                  : 'Unable to revoke invitation.'
              );
            } finally {
              setRevokingId(null);
            }
          },
        },
      ]
    );
  };

  const addMember = async () => {
    const userId = userIdInput.trim();
    if (!selectedTeam) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      setLocalError('Enter the registered user’s full UUID.');
      return;
    }
    setLocalError(null);
    try {
      await addMemberMutation.mutateAsync({ newUserId: userId, role: newRole });
      setUserIdInput('');
      setPage(1);
    } catch (requestError) {
      setLocalError(requestError instanceof ApiError ? requestError.message : 'Unable to add this registered user.');
    }
  };

  const changeRole = async (member: TeamMember) => {
    if (!selectedTeam || member.role === 'OWNER') return;
    const nextRole: ManagedRole = member.role === 'STAFF' ? 'MANAGER' : 'STAFF';
    setBusyMemberId(member.userId);
    setLocalError(null);
    try {
      await updateMemberRoleMutation.mutateAsync({ memberUserId: member.userId, role: nextRole });
      setPage(1);
    } catch (requestError) {
      setLocalError(requestError instanceof ApiError ? requestError.message : 'Unable to change this member’s role.');
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
          setLocalError(null);
          try {
            await removeMemberMutation.mutateAsync(member.userId);
            setPage(1);
          } catch (requestError) {
            setLocalError(requestError instanceof ApiError ? requestError.message : 'Unable to remove this member.');
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
      setLocalError('Unable to copy your user ID. You can select it manually.');
    }
  };

  if (!selectedTeam) return <Redirect href="/(app)/select-team" />;
  if (!user) return <Redirect href="/(auth)/login" />;

  const displayMembers = page === 1 && membersPageData ? membersPageData.members : accumulatedMembers;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshingMembers}
          onRefresh={handleRefresh}
          tintColor={colors.primary}
        />
      }
    >
      <BrandHeader badge="MEMBERS" title={selectedTeam.name} subtitle="Team members" />
      <View style={styles.navigationRow}>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/(app)')}>
          <Text style={styles.navLink}>Schedule</Text>
        </Pressable>
        <Text style={styles.navDivider}>{'\u00B7'}</Text>
        <Text style={styles.navCurrent}>Members</Text>
      </View>

      <View style={styles.identityCard}>
        <Text style={styles.eyebrow}>YOUR REGISTERED USER ID</Text>
        <Text selectable style={styles.userId}>{user.id}</Text>
        <Text style={styles.muted}>
          Share this ID with a team owner so they can add your existing account. This does not send an invitation.
        </Text>
        <ActionButton label={copied ? 'Copied' : 'Copy user ID'} onPress={copyUserId} variant="secondary" />
      </View>

      {isOwner ? (
        <>
          <View style={styles.manageCard}>
            <Text style={styles.sectionTitle}>Invite by email</Text>
            <Text style={styles.muted}>
              Send a secure one-time invitation link and code. The recipient can accept on mobile or register.
            </Text>
            <FormField
              label="Recipient email"
              value={inviteEmail}
              onChangeText={(text) => {
                setInviteEmail(text);
                if (inviteError) setInviteError(null);
                if (inviteSuccess) setInviteSuccess(null);
              }}
              placeholder="colleague@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.formLabel}>Role</Text>
            <View style={styles.roleRow}>
              {(['STAFF', 'MANAGER'] as ManagedRole[]).map((candidate) => (
                <Pressable
                  key={candidate}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: inviteRole === candidate }}
                  onPress={() => setInviteRole(candidate)}
                  style={[styles.roleOption, inviteRole === candidate && styles.roleSelected]}
                >
                  <Text style={[styles.roleOptionText, inviteRole === candidate && styles.roleSelectedText]}>
                    {candidate}
                  </Text>
                </Pressable>
              ))}
            </View>
            {inviteError ? <Text style={styles.error}>{inviteError}</Text> : null}
            {inviteSuccess ? <Text style={styles.success}>{inviteSuccess}</Text> : null}
            <ActionButton
              label="Send invitation"
              onPress={sendInvitation}
              loading={createInvitationMutation.isPending}
            />
          </View>

          {invitations.filter((i) => i.status === 'PENDING').length > 0 ? (
            <View style={styles.manageCard}>
              <Text style={styles.sectionTitle}>Pending invitations</Text>
              <Text style={styles.muted}>
                Active invitations awaiting acceptance.
              </Text>
              {invitations
                .filter((i) => i.status === 'PENDING')
                .map((inv) => (
                  <View key={inv.id} style={styles.invitationRow}>
                    <View style={styles.invitationInfo}>
                      <Text style={styles.invitationEmail}>{inv.invitedEmail}</Text>
                      <Text style={styles.invitationMeta}>
                        {inv.role} · Expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <ActionButton
                      size="small"
                      label={revokingId === inv.id ? 'Revoking...' : 'Revoke'}
                      variant="quiet"
                      loading={revokingId === inv.id}
                      disabled={revokingId !== null}
                      onPress={() => revokeInvitation(inv)}
                    />
                  </View>
                ))}
            </View>
          ) : null}

          <View style={styles.manageCard}>
            <Text style={styles.sectionTitle}>Add an existing user</Text>
            <Text style={styles.muted}>
              Enter the full UUID of a registered Rota user. New owners cannot be assigned here.
            </Text>
            <FormField
              label="Registered user ID"
              value={userIdInput}
              onChangeText={setUserIdInput}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.formLabel}>Role</Text>
            <View style={styles.roleRow}>
              {(['STAFF', 'MANAGER'] as ManagedRole[]).map((candidate) => (
                <Pressable
                  key={candidate}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: newRole === candidate }}
                  onPress={() => setNewRole(candidate)}
                  style={[styles.roleOption, newRole === candidate && styles.roleSelected]}
                >
                  <Text style={[styles.roleOptionText, newRole === candidate && styles.roleSelectedText]}>
                    {candidate}
                  </Text>
                </Pressable>
              ))}
            </View>
            <ActionButton
              label="Add registered user"
              onPress={addMember}
              loading={addMemberMutation.isPending}
            />
          </View>
        </>
      ) : null}

      <View style={styles.listHeader}>
        <View>
          <Text style={styles.sectionTitle}>People on this team</Text>
          <Text style={styles.muted}>
            {userRole ? `You are a ${userRole.toLowerCase()}.` : 'Your membership role is unavailable.'}
          </Text>
        </View>
        <Text style={styles.count}>{page === 1 ? displayMembers.length : '...'}</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loadingMembers && page === 1 ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : displayMembers.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No members found</Text>
          <Text style={styles.muted}>Refresh and try again.</Text>
        </View>
      ) : (
        displayMembers.map((member) => (
          <View key={member.userId} style={styles.memberCard}>
            <View style={styles.memberHeader}>
              <View style={styles.memberIdentity}>
                <Text style={styles.memberName}>{memberName(member)}</Text>
                <Text style={styles.memberEmail}>{member.user.email}</Text>
              </View>
              <Text style={[styles.roleBadge, member.role === 'OWNER' && styles.ownerBadge]}>
                {member.role}
              </Text>
            </View>
            {isOwner && member.role !== 'OWNER' ? (
              <View style={styles.memberActions}>
                <ActionButton
                  size="small"
                  label={busyMemberId === member.userId ? 'Saving...' : member.role === 'STAFF' ? 'Make manager' : 'Make staff'}
                  onPress={() => changeRole(member)}
                  loading={busyMemberId === member.userId}
                  variant="secondary"
                />
                <ActionButton
                  size="small"
                  label="Remove"
                  onPress={() => removeMember(member)}
                  disabled={busyMemberId !== null}
                  variant="quiet"
                />
              </View>
            ) : member.role === 'OWNER' ? (
              <Text style={styles.ownerNote}>Owners cannot be changed or removed.</Text>
            ) : null}
          </View>
        ))
      )}

      {hasMore ? (
        <ActionButton
          label={loadingMembers ? 'Loading...' : 'Load more members'}
          onPress={loadMore}
          loading={loadingMembers}
          variant="secondary"
        />
      ) : null}

      <View style={styles.bottomActions}>
        <ActionButton label="Change team" onPress={() => router.push('/(app)/select-team')} variant="secondary" />
        <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
      </View>
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
  success: { color: colors.success, fontSize: typography.sizes.sm, lineHeight: 20, marginBottom: spacing.md },
  invitationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  invitationInfo: { flex: 1 },
  invitationEmail: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700' },
  invitationMeta: { color: colors.textSecondary, fontSize: typography.sizes.xs, marginTop: 2 },
  bottomActions: { marginTop: spacing.xl, gap: spacing.sm },
});
