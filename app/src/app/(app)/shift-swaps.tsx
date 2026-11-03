import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
import { shiftSwapService } from '@/services/api/shiftSwapService';
import { teamService } from '@/services/api/teamService';
import {
  ShiftSwap,
  ShiftSwapShiftSummary,
  ShiftSwapStatus,
  TeamMember,
  TeamRole,
} from '@/types/api';

type TabType = 'INCOMING' | 'MY_REQUESTS' | 'MANAGER_REVIEW' | 'HISTORY';

const shiftDisplay = (shift: ShiftSwapShiftSummary) => {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const date = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const endTime = end.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${date} \u2022 ${startTime} \u2013 ${endTime}`;
};

const statusLabel = (status: ShiftSwapStatus): string => {
  switch (status) {
    case 'PENDING_PEER':
      return 'Pending Peer';
    case 'PENDING_MANAGER':
      return 'Awaiting Manager';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'DECLINED':
      return 'Declined';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
};

const statusBadgeColor = (status: ShiftSwapStatus) => {
  switch (status) {
    case 'PENDING_PEER':
      return { bg: '#FEF3C7', text: '#92400E' }; // Amber
    case 'PENDING_MANAGER':
      return { bg: '#EFF6FF', text: '#1E40AF' }; // Blue
    case 'APPROVED':
      return { bg: '#DCFCE7', text: '#166534' }; // Green
    case 'REJECTED':
    case 'DECLINED':
      return { bg: '#FEE2E2', text: '#991B1B' }; // Red
    case 'CANCELLED':
      return { bg: '#F1F5F9', text: '#64748B' }; // Gray
    default:
      return { bg: colors.border, text: colors.text };
  }
};

export default function ShiftSwapsScreen() {
  const router = useRouter();
  const { user, selectedTeam } = useAuth();

  const [activeTab, setActiveTab] = useState<TabType>('INCOMING');
  const [swaps, setSwaps] = useState<ShiftSwap[]>([]);
  const [role, setRole] = useState<TeamRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const pageRef = useRef(1);

  // Reject Modal state
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [selectedSwapForReject, setSelectedSwapForReject] = useState<ShiftSwap | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const canManage = role === 'OWNER' || role === 'MANAGER';

  // Load team role
  useEffect(() => {
    if (!selectedTeam || !user) return;
    teamService
      .listAllMembers(selectedTeam.id)
      .then((members) => {
        const myMember = members.find((m) => m.userId === user.id);
        setRole(myMember?.role || null);
      })
      .catch(() => setRole(null));
  }, [selectedTeam, user]);

  const loadSwaps = useCallback(
    async (reset = true) => {
      if (!selectedTeam) return;
      if (reset) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const page = reset ? 1 : pageRef.current + 1;
        const response = await shiftSwapService.list(selectedTeam.id, {
          page,
          limit: 30,
        });

        setSwaps((current) =>
          reset ? response.shiftSwaps : [...current, ...response.shiftSwaps]
        );
        pageRef.current = response.pagination.page;
        setPagination({
          page: response.pagination.page,
          totalPages: response.pagination.totalPages,
        });
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : 'Unable to load shift swaps.'
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [selectedTeam]
  );

  useEffect(() => {
    loadSwaps(true);
  }, [loadSwaps]);

  // Categorize swaps into tabs
  const incomingSwaps = useMemo(
    () =>
      swaps.filter(
        (s) => s.receivingUserId === user?.id && s.status === 'PENDING_PEER'
      ),
    [swaps, user]
  );

  const myRequests = useMemo(
    () =>
      swaps.filter(
        (s) =>
          s.requestingUserId === user?.id &&
          (s.status === 'PENDING_PEER' || s.status === 'PENDING_MANAGER')
      ),
    [swaps, user]
  );

  const managerReviewSwaps = useMemo(
    () => swaps.filter((s) => s.status === 'PENDING_MANAGER'),
    [swaps]
  );

  const historySwaps = useMemo(
    () =>
      swaps.filter((s) =>
        ['APPROVED', 'REJECTED', 'DECLINED', 'CANCELLED'].includes(s.status)
      ),
    [swaps]
  );

  const displayedSwaps = useMemo(() => {
    switch (activeTab) {
      case 'INCOMING':
        return incomingSwaps;
      case 'MY_REQUESTS':
        return myRequests;
      case 'MANAGER_REVIEW':
        return managerReviewSwaps;
      case 'HISTORY':
        return historySwaps;
      default:
        return [];
    }
  }, [activeTab, incomingSwaps, myRequests, managerReviewSwaps, historySwaps]);

  // Peer Response handler (Accept / Decline)
  const handlePeerResponse = (swap: ShiftSwap, action: 'accept' | 'decline') => {
    if (!selectedTeam) return;

    const actionText = action === 'accept' ? 'Accept' : 'Decline';
    const message =
      action === 'accept'
        ? `Accept this swap proposal?\n\nYou will exchange your shift "${swap.targetShift.title}" for "${swap.sourceShift.title}".\n\nNote: Accepting sends this to manager review. Assignments do not change until approved.`
        : `Decline this swap proposal?\n\nThe proposed exchange will be declined.`;

    Alert.alert(`${actionText} Swap Proposal?`, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: actionText,
        style: action === 'decline' ? 'destructive' : 'default',
        onPress: async () => {
          setActionLoadingId(swap.id);
          setError(null);
          try {
            await shiftSwapService.respond(selectedTeam.id, swap.id, { action });
            await loadSwaps(true);
          } catch (err) {
            const msg =
              err instanceof ApiError && err.statusCode === 409
                ? `${err.message} The swap request may have already been resolved.`
                : err instanceof ApiError
                ? err.message
                : 'Failed to respond to swap proposal.';
            setError(msg);
            await loadSwaps(true);
          } finally {
            setActionLoadingId(null);
          }
        },
      },
    ]);
  };

  // Manager Review handler (Approve)
  const handleApprove = (swap: ShiftSwap) => {
    if (!selectedTeam) return;

    Alert.alert(
      'Approve Shift Swap?',
      `Approve exchange between ${swap.requestingUser.name || swap.requestingUser.email} and ${swap.receivingUser.name || swap.receivingUser.email}?\n\nBoth shift assignments will be exchanged atomically immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve & Exchange',
          onPress: async () => {
            setActionLoadingId(swap.id);
            setError(null);
            try {
              await shiftSwapService.review(selectedTeam.id, swap.id, {
                action: 'approve',
              });
              Alert.alert(
                'Swap Approved',
                'The shift assignments have been updated in the schedule.'
              );
              await loadSwaps(true);
            } catch (err) {
              const msg =
                err instanceof ApiError && err.statusCode === 409
                  ? `Cannot approve swap: ${err.message}. The schedule has changed.`
                  : err instanceof ApiError
                  ? err.message
                  : 'Failed to approve swap.';
              setError(msg);
              await loadSwaps(true);
            } finally {
              setActionLoadingId(null);
            }
          },
        },
      ]
    );
  };

  // Manager Review handler (Reject Modal Open)
  const openRejectModal = (swap: ShiftSwap) => {
    setSelectedSwapForReject(swap);
    setRejectReason('');
    setRejectError(null);
    setRejectModalVisible(true);
  };

  // Submit Manager Rejection
  const submitReject = async () => {
    if (!selectedTeam || !selectedSwapForReject) return;

    setRejecting(true);
    setRejectError(null);

    try {
      await shiftSwapService.review(selectedTeam.id, selectedSwapForReject.id, {
        action: 'reject',
        reason: rejectReason.trim() || undefined,
      });
      setRejectModalVisible(false);
      await loadSwaps(true);
    } catch (err) {
      setRejectError(
        err instanceof ApiError ? err.message : 'Failed to reject swap.'
      );
    } finally {
      setRejecting(false);
    }
  };

  // Requester Cancel handler
  const handleCancel = (swap: ShiftSwap) => {
    if (!selectedTeam) return;

    Alert.alert(
      'Cancel Swap Request?',
      'Are you sure you want to cancel this swap request? This cannot be undone.',
      [
        { text: 'Keep Request', style: 'cancel' },
        {
          text: 'Cancel Swap',
          style: 'destructive',
          onPress: async () => {
            setActionLoadingId(swap.id);
            setError(null);
            try {
              await shiftSwapService.cancel(selectedTeam.id, swap.id);
              await loadSwaps(true);
            } catch (err) {
              const msg =
                err instanceof ApiError && err.statusCode === 409
                  ? `${err.message} The request may already be resolved.`
                  : err instanceof ApiError
                  ? err.message
                  : 'Failed to cancel swap request.';
              setError(msg);
              await loadSwaps(true);
            } finally {
              setActionLoadingId(null);
            }
          },
        },
      ]
    );
  };

  const hasMore = pagination.page < pagination.totalPages;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            loadSwaps(true);
          }}
          tintColor={colors.primary}
        />
      }
    >
      <BrandHeader
        badge="WORKSPACE"
        title="Shift Swaps"
        subtitle={selectedTeam ? selectedTeam.name : 'Manage shift requests'}
      />

      <View style={styles.topNavRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backLink}
        >
          <Text style={styles.backLinkText}>← Back to Schedule</Text>
        </Pressable>
        <ActionButton
          size="small"
          label="+ Propose swap"
          onPress={() => router.push('/(app)/swap-request' as any)}
          variant="secondary"
        />
      </View>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'INCOMING' }}
          onPress={() => setActiveTab('INCOMING')}
          style={[styles.tab, activeTab === 'INCOMING' && styles.tabActive]}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'INCOMING' && styles.tabTextActive,
            ]}
          >
            Incoming {incomingSwaps.length > 0 ? `(${incomingSwaps.length})` : ''}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'MY_REQUESTS' }}
          onPress={() => setActiveTab('MY_REQUESTS')}
          style={[styles.tab, activeTab === 'MY_REQUESTS' && styles.tabActive]}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'MY_REQUESTS' && styles.tabTextActive,
            ]}
          >
            My Requests {myRequests.length > 0 ? `(${myRequests.length})` : ''}
          </Text>
        </Pressable>

        {canManage ? (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'MANAGER_REVIEW' }}
            onPress={() => setActiveTab('MANAGER_REVIEW')}
            style={[
              styles.tab,
              activeTab === 'MANAGER_REVIEW' && styles.tabActive,
            ]}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === 'MANAGER_REVIEW' && styles.tabTextActive,
              ]}
            >
              Review {managerReviewSwaps.length > 0 ? `(${managerReviewSwaps.length})` : ''}
            </Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'HISTORY' }}
          onPress={() => setActiveTab('HISTORY')}
          style={[styles.tab, activeTab === 'HISTORY' && styles.tabActive]}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'HISTORY' && styles.tabTextActive,
            ]}
          >
            History
          </Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      {/* Swaps List */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : displayedSwaps.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No swap requests</Text>
          <Text style={styles.muted}>
            {activeTab === 'INCOMING'
              ? 'You have no incoming shift swap proposals awaiting your response.'
              : activeTab === 'MY_REQUESTS'
              ? 'You have no active pending swap requests.'
              : activeTab === 'MANAGER_REVIEW'
              ? 'No shift swaps currently require manager approval.'
              : 'No completed or archived shift swaps found.'}
          </Text>
          <ActionButton
            label="Propose a shift swap"
            onPress={() => router.push('/(app)/swap-request' as any)}
            variant="secondary"
          />
        </View>
      ) : (
        <View style={styles.listWrap}>
          {displayedSwaps.map((swap) => {
            const isActorRequester = swap.requestingUserId === user?.id;
            const isActorRecipient = swap.receivingUserId === user?.id;
            const isLoadingThis = actionLoadingId === swap.id;
            const badge = statusBadgeColor(swap.status);

            return (
              <View key={swap.id} style={styles.swapCard}>
                {/* Header: Status and Date */}
                <View style={styles.swapHeader}>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: badge.bg },
                    ]}
                  >
                    <Text
                      style={[styles.statusBadgeText, { color: badge.text }]}
                    >
                      {statusLabel(swap.status)}
                    </Text>
                  </View>
                  <Text style={styles.metaTimestamp}>
                    {new Date(swap.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </Text>
                </View>

                {/* Shift Comparison */}
                <View style={styles.shiftsRow}>
                  {/* Source Shift */}
                  <View style={styles.shiftCol}>
                    <Text style={styles.roleEyebrow}>
                      {isActorRequester ? 'YOU GIVE UP' : `${swap.requestingUser.name || swap.requestingUser.email} GIVES`}
                    </Text>
                    <Text style={styles.shiftTitle}>{swap.sourceShift.title}</Text>
                    <Text style={styles.shiftTime}>
                      {shiftDisplay(swap.sourceShift)}
                    </Text>
                  </View>

                  <Text style={styles.arrowIcon}>⇄</Text>

                  {/* Target Shift */}
                  <View style={styles.shiftCol}>
                    <Text style={styles.roleEyebrow}>
                      {isActorRecipient ? 'YOU GIVE UP' : `${swap.receivingUser.name || swap.receivingUser.email} GIVES`}
                    </Text>
                    <Text style={styles.shiftTitle}>{swap.targetShift.title}</Text>
                    <Text style={styles.shiftTime}>
                      {shiftDisplay(swap.targetShift)}
                    </Text>
                  </View>
                </View>

                {/* Parties Involved */}
                <Text style={styles.partiesSummary}>
                  Requester: {swap.requestingUser.name || swap.requestingUser.email}
                  {'\n'}Recipient: {swap.receivingUser.name || swap.receivingUser.email}
                </Text>

                {/* Rejection / Notes */}
                {swap.rejectionReason ? (
                  <View style={styles.reasonCard}>
                    <Text style={styles.reasonLabel}>Reason:</Text>
                    <Text style={styles.reasonText}>{swap.rejectionReason}</Text>
                  </View>
                ) : null}

                {/* ACTION 1: Peer Acceptance / Decline */}
                {swap.status === 'PENDING_PEER' && isActorRecipient ? (
                  <View style={styles.actionBlock}>
                    <Text style={styles.actionNotice}>
                      Accepting forwards this request to manager review. Shift schedules do not change until approved.
                    </Text>
                    <View style={styles.buttonRow}>
                      <ActionButton
                        size="small"
                        label="Accept proposal"
                        onPress={() => handlePeerResponse(swap, 'accept')}
                        loading={isLoadingThis}
                        disabled={Boolean(actionLoadingId)}
                      />
                      <ActionButton
                        size="small"
                        label="Decline"
                        variant="quiet"
                        onPress={() => handlePeerResponse(swap, 'decline')}
                        disabled={Boolean(actionLoadingId)}
                      />
                    </View>
                  </View>
                ) : null}

                {/* ACTION 2: Manager Approval / Rejection */}
                {swap.status === 'PENDING_MANAGER' && canManage ? (
                  <View style={styles.actionBlock}>
                    <Text style={styles.actionNotice}>
                      Peer has accepted. Manager approval atomically exchanges shift assignments for both team members.
                    </Text>
                    <View style={styles.buttonRow}>
                      <ActionButton
                        size="small"
                        label="Approve swap"
                        onPress={() => handleApprove(swap)}
                        loading={isLoadingThis}
                        disabled={Boolean(actionLoadingId)}
                      />
                      <ActionButton
                        size="small"
                        label="Reject"
                        variant="secondary"
                        onPress={() => openRejectModal(swap)}
                        disabled={Boolean(actionLoadingId)}
                      />
                    </View>
                  </View>
                ) : null}

                {/* ACTION 3: Requester Cancellation */}
                {isActorRequester &&
                (swap.status === 'PENDING_PEER' ||
                  swap.status === 'PENDING_MANAGER') ? (
                  <View style={styles.cancelRow}>
                    <ActionButton
                      size="small"
                      label="Cancel request"
                      variant="quiet"
                      onPress={() => handleCancel(swap)}
                      loading={isLoadingThis}
                      disabled={Boolean(actionLoadingId)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}

          {hasMore ? (
            <ActionButton
              label={loadingMore ? 'Loading more...' : 'Load more'}
              onPress={() => loadSwaps(false)}
              variant="secondary"
              loading={loadingMore}
            />
          ) : null}
        </View>
      )}

      {/* Rejection Modal */}
      <Modal
        visible={rejectModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setRejectModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.eyebrow}>MANAGER REVIEW</Text>
            <Text style={styles.modalTitle}>Reject Shift Swap</Text>
            <Text style={styles.muted}>
              You can provide an optional explanation to the staff members (max 500 characters).
            </Text>

            <FormField
              label="Rejection Reason (Optional)"
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder="e.g. Schedule conflicts, understaffed during holiday coverage..."
              maxLength={500}
              autoCapitalize="sentences"
            />

            {rejectError ? (
              <Text style={styles.errorText}>{rejectError}</Text>
            ) : null}

            <View style={styles.modalButtons}>
              <ActionButton
                label={rejecting ? 'Rejecting...' : 'Confirm Rejection'}
                onPress={submitReject}
                loading={rejecting}
                variant="secondary"
              />
              <ActionButton
                label="Cancel"
                variant="quiet"
                onPress={() => setRejectModalVisible(false)}
                disabled={rejecting}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  topNavRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  backLink: { alignSelf: 'flex-start' },
  backLinkText: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginBottom: spacing.md,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    fontWeight: '700',
  },
  tabTextActive: { color: '#FFFFFF' },
  errorBanner: {
    color: colors.error,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    padding: spacing.sm,
    fontSize: typography.sizes.sm,
    marginBottom: spacing.md,
  },
  listWrap: { gap: spacing.md },
  swapCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: spacing.md,
  },
  swapHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 8,
  },
  statusBadgeText: {
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  metaTimestamp: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
  },
  shiftsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  shiftCol: { flex: 1 },
  roleEyebrow: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  shiftTitle: {
    color: colors.text,
    fontSize: typography.sizes.sm,
    fontWeight: '800',
  },
  shiftTime: {
    color: colors.primary,
    fontSize: typography.sizes.xs,
    fontWeight: '600',
    marginTop: 2,
  },
  arrowIcon: {
    fontSize: 18,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xs,
  },
  partiesSummary: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  reasonCard: {
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  reasonLabel: {
    color: '#991B1B',
    fontSize: typography.sizes.xs,
    fontWeight: '800',
  },
  reasonText: {
    color: colors.text,
    fontSize: typography.sizes.xs,
    marginTop: 2,
  },
  actionBlock: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  actionNotice: {
    color: colors.primaryDark,
    fontSize: typography.sizes.xs,
    lineHeight: 16,
    marginBottom: spacing.sm,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cancelRow: {
    marginTop: spacing.sm,
    alignItems: 'flex-start',
  },
  loader: { marginVertical: spacing.xl },
  emptyCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: spacing.lg,
    alignItems: 'center',
  },
  emptyTitle: {
    color: colors.text,
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  muted: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalCard: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  modalTitle: {
    color: colors.text,
    fontSize: typography.sizes.xl,
    fontWeight: '800',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  modalButtons: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  errorText: {
    color: colors.error,
    fontSize: typography.sizes.sm,
    marginBottom: spacing.sm,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  bottomSpacer: { height: spacing.xl },
});

