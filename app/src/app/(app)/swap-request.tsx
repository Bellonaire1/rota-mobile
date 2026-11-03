import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { shiftService } from '@/services/api/shiftService';
import { shiftSwapService } from '@/services/api/shiftSwapService';
import { Shift } from '@/types/api';

const shiftDisplay = (shift: Shift) => {
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

export default function SwapRequestScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ sourceShiftId?: string }>();
  const { user, selectedTeam } = useAuth();

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    params.sourceShiftId || ''
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const pageRef = useRef(1);

  const currentTeamIdRef = useRef<string | null>(selectedTeam?.id ?? null);
  const requestGenerationRef = useRef(0);

  // Team-switching safety: clear stale shifts and reset selections immediately when selectedTeam changes
  useEffect(() => {
    currentTeamIdRef.current = selectedTeam?.id ?? null;
    requestGenerationRef.current += 1;
    setShifts([]);
    setSelectedSourceId(params.sourceShiftId || '');
    setSelectedTargetId('');
    setPagination({ page: 1, totalPages: 1 });
    pageRef.current = 1;
    setError(null);
  }, [params.sourceShiftId, selectedTeam?.id]);

  const loadShifts = useCallback(
    async (reset = true) => {
      const teamId = selectedTeam?.id;
      if (!teamId) return;
      const generation = requestGenerationRef.current;

      if (reset) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const page = reset ? 1 : pageRef.current + 1;
        const response = await shiftService.list(teamId, {
          page,
          limit: 30,
          status: 'SCHEDULED',
        });

        if (currentTeamIdRef.current !== teamId || requestGenerationRef.current !== generation) {
          return;
        }

        setShifts((current) =>
          reset ? response.shifts : [...current, ...response.shifts]
        );
        pageRef.current = response.pagination.page;
        setPagination({
          page: response.pagination.page,
          totalPages: response.pagination.totalPages,
        });
      } catch (err) {
        if (currentTeamIdRef.current === teamId && requestGenerationRef.current === generation) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Unable to load scheduled shifts.'
          );
        }
      } finally {
        if (currentTeamIdRef.current === teamId && requestGenerationRef.current === generation) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [selectedTeam?.id]
  );

  // Focus refresh: reload shifts whenever screen regains focus
  useFocusEffect(
    useCallback(() => {
      const teamId = selectedTeam?.id;
      if (!teamId) return;
      loadShifts(true);
    }, [loadShifts, selectedTeam?.id])
  );

  // Own scheduled shifts
  const myShifts = useMemo(
    () =>
      shifts.filter(
        (s) => s.assignedToUserId === user?.id && s.status === 'SCHEDULED'
      ),
    [shifts, user]
  );

  // Eligible colleague shifts (scheduled, assigned to someone else)
  const eligibleTargetShifts = useMemo(() => {
    return shifts.filter((s) => {
      if (s.assignedToUserId === user?.id) return false;
      if (s.status !== 'SCHEDULED') return false;
      if (s.id === selectedSourceId) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const titleMatch = s.title.toLowerCase().includes(query);
        const nameMatch = (s.assignedTo.name || '').toLowerCase().includes(query);
        const emailMatch = s.assignedTo.email.toLowerCase().includes(query);
        return titleMatch || nameMatch || emailMatch;
      }
      return true;
    });
  }, [shifts, user, selectedSourceId, searchQuery]);

  // Set default source shift if only 1 exists or if param is matched
  useEffect(() => {
    if (params.sourceShiftId) {
      setSelectedSourceId(params.sourceShiftId);
    } else if (!selectedSourceId && myShifts.length > 0) {
      setSelectedSourceId(myShifts[0].id);
    }
  }, [params.sourceShiftId, myShifts, selectedSourceId]);

  const sourceShift = useMemo(
    () => myShifts.find((s) => s.id === selectedSourceId),
    [myShifts, selectedSourceId]
  );

  const targetShift = useMemo(
    () => shifts.find((s) => s.id === selectedTargetId),
    [shifts, selectedTargetId]
  );

  const handleSubmit = async () => {
    if (!selectedTeam || !sourceShift || !targetShift) return;

    if (sourceShift.id === targetShift.id) {
      setError('You cannot swap a shift with itself.');
      return;
    }

    if (sourceShift.assignedToUserId === targetShift.assignedToUserId) {
      setError('You cannot swap shifts with yourself.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await shiftSwapService.create(selectedTeam.id, {
        sourceShiftId: sourceShift.id,
        targetShiftId: targetShift.id,
      });

      Alert.alert(
        'Swap Proposal Sent',
        `Your proposal to swap "${sourceShift.title}" for "${targetShift.title}" with ${targetShift.assignedTo.name || targetShift.assignedTo.email} has been submitted.\n\nNext steps:\n1. Your colleague must accept the proposal.\n2. A manager must review and approve it to finalize the exchange.`,
        [
          {
            text: 'View Swaps',
            onPress: () => router.replace('/(app)/shift-swaps'),
          },
          {
            text: 'Back to Schedule',
            onPress: () => router.replace('/(app)'),
          },
        ]
      );
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          setError(
            `${err.message} One of the shifts may already be involved in a pending swap request.`
          );
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to submit swap proposal. Please check your connection.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasMore = pagination.page < pagination.totalPages;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            loadShifts(true);
          }}
          tintColor={colors.primary}
        />
      }
    >
      <BrandHeader
        badge="SHIFT SWAP"
        title="Propose a Swap"
        subtitle={selectedTeam ? selectedTeam.name : 'Select shifts'}
      />

      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={styles.backLink}
      >
        <Text style={styles.backLinkText}>← Back to Schedule</Text>
      </Pressable>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      {/* SECTION 1: Shift to give up */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>STEP 1: YOUR SHIFT (GIVING UP)</Text>
        <Text style={styles.sectionTitle}>Select shift you want to give away</Text>

        {myShifts.length === 0 ? (
          <Text style={styles.mutedText}>
            You have no upcoming scheduled shifts on this team to swap.
          </Text>
        ) : (
          <View style={styles.radioList}>
            {myShifts.map((shift) => {
              const isSelected = shift.id === selectedSourceId;
              return (
                <Pressable
                  key={shift.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  onPress={() => setSelectedSourceId(shift.id)}
                  style={[
                    styles.shiftOption,
                    isSelected && styles.shiftOptionSelected,
                  ]}
                >
                  <View style={styles.optionContent}>
                    <Text style={styles.optionTitle}>{shift.title}</Text>
                    <Text style={styles.optionDate}>{shiftDisplay(shift)}</Text>
                  </View>
                  <View
                    style={[
                      styles.radioIndicator,
                      isSelected && styles.radioIndicatorSelected,
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      {/* SECTION 2: Shift to receive */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>STEP 2: COLLEAGUE'S SHIFT (RECEIVING)</Text>
        <Text style={styles.sectionTitle}>Select the shift you want in exchange</Text>

        <FormField
          label="Search colleagues or shifts"
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Filter by name or shift title..."
          autoCapitalize="none"
        />

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : eligibleTargetShifts.length === 0 ? (
          <Text style={styles.mutedText}>
            No eligible colleague shifts found. Shifts must belong to other team members and be currently scheduled.
          </Text>
        ) : (
          <View style={styles.radioList}>
            {eligibleTargetShifts.map((shift) => {
              const isSelected = shift.id === selectedTargetId;
              return (
                <Pressable
                  key={shift.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  onPress={() => setSelectedTargetId(shift.id)}
                  style={[
                    styles.shiftOption,
                    isSelected && styles.shiftOptionSelected,
                  ]}
                >
                  <View style={styles.optionContent}>
                    <Text style={styles.optionTitle}>{shift.title}</Text>
                    <Text style={styles.optionDate}>{shiftDisplay(shift)}</Text>
                    <Text style={styles.optionAssignee}>
                      Staff: {shift.assignedTo.name || shift.assignedTo.email}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.radioIndicator,
                      isSelected && styles.radioIndicatorSelected,
                    ]}
                  />
                </Pressable>
              );
            })}
            {hasMore ? (
              <ActionButton
                label={loadingMore ? 'Loading more...' : 'Load more shifts'}
                onPress={() => loadShifts(false)}
                variant="secondary"
                loading={loadingMore}
                size="small"
              />
            ) : null}
          </View>
        )}
      </View>

      {/* SECTION 3: Review and Submit */}
      {sourceShift && targetShift ? (
        <View style={styles.reviewCard}>
          <Text style={styles.eyebrow}>STEP 3: REVIEW PROPOSED EXCHANGE</Text>
          <Text style={styles.sectionTitle}>Exchange Summary</Text>

          <View style={styles.comparisonContainer}>
            <View style={styles.comparisonBox}>
              <Text style={styles.comparisonTagGiving}>YOU GIVE UP</Text>
              <Text style={styles.comparisonTitle}>{sourceShift.title}</Text>
              <Text style={styles.comparisonDate}>{shiftDisplay(sourceShift)}</Text>
              <Text style={styles.comparisonUser}>Current assignee: You</Text>
            </View>

            <View style={styles.swapArrowWrap}>
              <Text style={styles.swapArrow}>⇄</Text>
            </View>

            <View style={styles.comparisonBox}>
              <Text style={styles.comparisonTagReceiving}>YOU RECEIVE</Text>
              <Text style={styles.comparisonTitle}>{targetShift.title}</Text>
              <Text style={styles.comparisonDate}>{shiftDisplay(targetShift)}</Text>
              <Text style={styles.comparisonUser}>
                Current assignee:{' '}
                {targetShift.assignedTo.name || targetShift.assignedTo.email}
              </Text>
            </View>
          </View>

          <View style={styles.disclaimerBox}>
            <Text style={styles.disclaimerText}>
              • Your colleague must review and accept this proposal first.{'\n'}
              • Once accepted, a manager must review and approve it.{'\n'}
              • Shift assignments remain unchanged until manager approval.
            </Text>
          </View>

          <ActionButton
            label={submitting ? 'Submitting proposal...' : 'Submit Swap Proposal'}
            onPress={handleSubmit}
            loading={submitting}
            disabled={submitting}
          />
        </View>
      ) : null}

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  backLink: { alignSelf: 'flex-start', marginBottom: spacing.md },
  backLinkText: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  reviewCard: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 20,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  radioList: { marginTop: spacing.xs, gap: spacing.xs },
  shiftOption: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shiftOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: '#EEF2FF',
  },
  optionContent: { flex: 1, marginRight: spacing.sm },
  optionTitle: {
    color: colors.text,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
  optionDate: {
    color: colors.primary,
    fontSize: typography.sizes.xs,
    fontWeight: '600',
    marginTop: 2,
  },
  optionAssignee: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    marginTop: 2,
  },
  radioIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
  },
  radioIndicatorSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  loader: { marginVertical: spacing.md },
  mutedText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 20,
    marginVertical: spacing.xs,
  },
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
  comparisonContainer: {
    marginVertical: spacing.sm,
    gap: spacing.sm,
  },
  comparisonBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.sm,
  },
  comparisonTagGiving: {
    color: '#DC2626',
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 2,
  },
  comparisonTagReceiving: {
    color: '#16A34A',
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 2,
  },
  comparisonTitle: {
    color: colors.text,
    fontSize: typography.sizes.md,
    fontWeight: '800',
  },
  comparisonDate: {
    color: colors.primary,
    fontSize: typography.sizes.xs,
    fontWeight: '700',
    marginTop: 2,
  },
  comparisonUser: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    marginTop: 2,
  },
  swapArrowWrap: {
    alignItems: 'center',
    marginVertical: -spacing.xs,
  },
  swapArrow: {
    fontSize: 22,
    color: colors.primary,
    fontWeight: '900',
  },
  disclaimerBox: {
    backgroundColor: 'rgba(30, 64, 175, 0.05)',
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  disclaimerText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    lineHeight: 18,
  },
  bottomSpacer: { height: spacing.xl },
});

