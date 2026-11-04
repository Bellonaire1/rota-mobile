import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { colors, spacing, typography } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { activityService } from '@/services/api/activityService';
import { ApiError } from '@/services/api/apiClient';
import { ActivityEvent, ActivityEventType } from '@/types/api';

/**
 * ARCHITECTURAL JUSTIFICATION: FlatList vs. ScrollView vs. FlashList
 * -----------------------------------------------------------------
 * 1. FlatList vs. ScrollView:
 *    - ScrollView renders all children in memory simultaneously upon mounting. In high-volume
 *      audit logs (which can easily grow into hundreds or thousands of events), ScrollView leads
 *      to unbounded memory consumption, severe JS-thread frame drops, and initial render lag.
 *    - FlatList virtualizes unrendered offscreen elements, recycling views and maintaining
 *      predictable memory usage and smooth 60fps scrolling on resource-constrained mobile devices.
 *
 * 2. FlatList vs. FlashList:
 *    - FlashList (@shopify/flash-list) is a high-performance alternative, but introduces an
 *      external native/hybrid package dependency not included in the existing project baseline.
 *    - Adding external native dependencies risks native ABI mismatch, Expo Go/EAS development
 *      build breakage, and increases binary size unnecessarily for a feed with standard item heights.
 *    - FlatList is built directly into core React Native, requires 0 third-party packages,
 *      reliably supports RefreshControl and cursor-based infinite append, and satisfies all
 *      graduation performance criteria (R05.5, R05.6) out of the box.
 */

const PAGE_SIZE = 20;

/**
 * Formats ISO timestamps into readable localized dates and times in the device's timezone.
 */
const formatEventDateTime = (isoString: string): string => {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const datePart = date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${datePart} \u2022 ${timePart}`;
  } catch {
    return isoString;
  }
};

/**
 * Formats shift start and end times for metadata display in device timezone.
 */
const formatShiftRange = (startsAt?: unknown, endsAt?: unknown): string | null => {
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string') return null;
  try {
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    const date = start.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date} (${startTime} \u2013 ${endTime})`;
  } catch {
    return null;
  }
};

interface EventPresentation {
  categoryBadge: string;
  badgeBg: string;
  badgeTextColor: string;
  title: string;
  actorText: string;
  description: string;
  metadataDetails: Array<{ label: string; value: string }>;
}

/**
 * Derives user-facing titles, descriptions, category badges, and safe metadata for all 12 events.
 */
const getEventPresentation = (event: ActivityEvent): EventPresentation => {
  const actorText = event.actor?.name || event.actor?.email || 'A team member';
  const meta = event.metadata || {};
  const metadataDetails: Array<{ label: string; value: string }> = [];

  switch (event.type) {
    case 'SHIFT_CREATED': {
      const range = formatShiftRange(meta.startsAt || meta.start, meta.endsAt || meta.end);
      if (range) metadataDetails.push({ label: 'Scheduled window', value: range });
      return {
        categoryBadge: 'SHIFT',
        badgeBg: '#EFF6FF',
        badgeTextColor: '#1E40AF',
        title: 'Shift Scheduled',
        actorText,
        description: `${actorText} scheduled a new shift.`,
        metadataDetails,
      };
    }

    case 'SHIFT_UPDATED': {
      const range = formatShiftRange(meta.startsAt || meta.start, meta.endsAt || meta.end);
      if (range) metadataDetails.push({ label: 'Updated window', value: range });
      return {
        categoryBadge: 'SHIFT',
        badgeBg: '#EFF6FF',
        badgeTextColor: '#1E40AF',
        title: 'Shift Updated',
        actorText,
        description: `${actorText} updated shift details.`,
        metadataDetails,
      };
    }

    case 'SHIFT_CANCELLED': {
      return {
        categoryBadge: 'SHIFT',
        badgeBg: '#FEE2E2',
        badgeTextColor: '#991B1B',
        title: 'Shift Cancelled',
        actorText,
        description: `${actorText} cancelled a scheduled shift.`,
        metadataDetails,
      };
    }

    case 'MEMBER_ADDED': {
      if (meta.role) metadataDetails.push({ label: 'Role', value: String(meta.role) });
      return {
        categoryBadge: 'ROSTER',
        badgeBg: '#EDE9FE',
        badgeTextColor: '#6D28D9',
        title: 'Member Added',
        actorText,
        description: `${actorText} added a new member to the team.`,
        metadataDetails,
      };
    }

    case 'MEMBER_ROLE_CHANGED': {
      const newRole = meta.newRole || meta.role;
      if (newRole) metadataDetails.push({ label: 'Assigned role', value: String(newRole) });
      return {
        categoryBadge: 'ROSTER',
        badgeBg: '#EDE9FE',
        badgeTextColor: '#6D28D9',
        title: 'Role Changed',
        actorText,
        description: `${actorText} changed a team member's role.`,
        metadataDetails,
      };
    }

    case 'MEMBER_REMOVED': {
      return {
        categoryBadge: 'ROSTER',
        badgeBg: '#FEE2E2',
        badgeTextColor: '#991B1B',
        title: 'Member Removed',
        actorText,
        description: `${actorText} removed a member from the team.`,
        metadataDetails,
      };
    }

    case 'SWAP_REQUESTED': {
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#FEF3C7',
        badgeTextColor: '#92400E',
        title: 'Swap Proposed',
        actorText,
        description: `${actorText} proposed a peer-to-peer shift swap.`,
        metadataDetails,
      };
    }

    case 'SWAP_PEER_ACCEPTED': {
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#DCFCE7',
        badgeTextColor: '#166534',
        title: 'Swap Accepted by Peer',
        actorText,
        description: `${actorText} accepted the swap proposal (awaiting manager review).`,
        metadataDetails,
      };
    }

    case 'SWAP_PEER_DECLINED': {
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#FEE2E2',
        badgeTextColor: '#991B1B',
        title: 'Swap Declined by Peer',
        actorText,
        description: `${actorText} declined the shift swap proposal.`,
        metadataDetails,
      };
    }

    case 'SWAP_APPROVED': {
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#DCFCE7',
        badgeTextColor: '#166534',
        title: 'Swap Approved',
        actorText,
        description: `${actorText} approved the shift swap. Shifts exchanged atomically.`,
        metadataDetails,
      };
    }

    case 'SWAP_REJECTED': {
      const reason = meta.rejectionReason || meta.reason;
      if (reason) metadataDetails.push({ label: 'Reason', value: `"${String(reason)}"` });
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#FEE2E2',
        badgeTextColor: '#991B1B',
        title: 'Swap Rejected',
        actorText,
        description: `${actorText} rejected the shift swap proposal.`,
        metadataDetails,
      };
    }

    case 'SWAP_CANCELLED': {
      return {
        categoryBadge: 'SWAP',
        badgeBg: '#F1F5F9',
        badgeTextColor: '#64748B',
        title: 'Swap Cancelled',
        actorText,
        description: `${actorText} cancelled the shift swap proposal.`,
        metadataDetails,
      };
    }

    default: {
      return {
        categoryBadge: 'SYSTEM',
        badgeBg: '#F1F5F9',
        badgeTextColor: '#64748B',
        title: (event.type as string).replace(/_/g, ' '),
        actorText,
        description: `${actorText} performed an action.`,
        metadataDetails,
      };
    }
  }
};

/**
 * Activity Item Row Component
 */
const ActivityItem = React.memo(({ event }: { event: ActivityEvent }) => {
  const presentation = useMemo(() => getEventPresentation(event), [event]);
  const formattedTimestamp = useMemo(() => formatEventDateTime(event.createdAt), [event.createdAt]);

  return (
    <View style={styles.card} accessible accessibilityRole="text" accessibilityLabel={`${presentation.title}, ${presentation.description}, ${formattedTimestamp}`}>
      <View style={styles.cardHeader}>
        <View style={[styles.badge, { backgroundColor: presentation.badgeBg }]}>
          <Text style={[styles.badgeText, { color: presentation.badgeTextColor }]}>
            {presentation.categoryBadge}
          </Text>
        </View>
        <Text style={styles.timestamp}>{formattedTimestamp}</Text>
      </View>

      <Text style={styles.eventTitle}>{presentation.title}</Text>
      <Text style={styles.eventDescription}>{presentation.description}</Text>

      {presentation.metadataDetails.length > 0 ? (
        <View style={styles.metadataContainer}>
          {presentation.metadataDetails.map((detail, idx) => (
            <View key={idx} style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>{detail.label}: </Text>
              <Text style={styles.metadataValue}>{detail.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

export default function ActivityScreen() {
  const router = useRouter();
  const { user, selectedTeam } = useAuth();

  // Feed state is keyed by teamId to ensure complete state isolation across teams.
  // Team A events can never render under Team B's heading under any lifecycle timing.
  const [feedState, setFeedState] = useState<{
    teamId: string | null;
    events: ActivityEvent[];
  }>({
    teamId: selectedTeam?.id || null,
    events: [],
  });

  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);

  // Concurrency & race-condition cancellation refs
  const nextCursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const isFetchingMoreRef = useRef(false);
  const isLoadingInitialRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const teamIdRef = useRef<string | null>(selectedTeam?.id || null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const eventsCountRef = useRef(0);
  const isMountedRef = useRef(true);

  // Sync teamIdRef
  useEffect(() => {
    teamIdRef.current = selectedTeam?.id || null;
  }, [selectedTeam?.id]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * Visible events derived strictly from current selectedTeam:
   * If selectedTeam changes, visibleEvents immediately returns []
   * before any effect runs, during loading, or if the request fails.
   */
  const visibleEvents = useMemo(() => {
    if (!selectedTeam?.id || feedState.teamId !== selectedTeam.id) {
      return [];
    }
    return feedState.events;
  }, [selectedTeam?.id, feedState]);

  /**
   * Translates errors into actionable user-facing messages.
   */
  const formatErrorMessage = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.statusCode === 401) {
        return 'Your session has expired. Please sign in again.';
      }
      if (err.statusCode === 403) {
        return 'You do not have permission to view activity for this team.';
      }
      if (err.statusCode === 404) {
        return 'Team activity is unavailable or you are not a member of this team.';
      }
      if (err.statusCode === 400) {
        return err.message || 'Invalid pagination request.';
      }
      return err.message || `Server request failed (Status ${err.statusCode}).`;
    }
    return (err as Error)?.message || 'Unable to connect to the server. Please check your connection.';
  };

  /**
   * Loads the initial page of activity events for the selected team.
   */
  const loadInitialFeed = useCallback(async (teamId: string) => {
    if (!teamId) return;

    const gen = ++requestGenerationRef.current;
    isLoadingInitialRef.current = true;
    setIsLoadingInitial(true);
    setError(null);
    setPaginationError(null);

    // Reset pagination tracking immediately for this team
    seenEventIdsRef.current.clear();
    nextCursorRef.current = null;
    hasMoreRef.current = false;
    setHasMore(false);

    try {
      const response = await activityService.getTeamActivity(teamId, { limit: PAGE_SIZE });

      // Guard against stale responses from previous teams or cancelled generations
      if (gen !== requestGenerationRef.current || teamIdRef.current !== teamId || !isMountedRef.current) {
        return;
      }

      const receivedEvents = response.events || [];
      const idSet = new Set<string>();
      const deduped: ActivityEvent[] = [];

      for (const ev of receivedEvents) {
        if (!idSet.has(ev.id)) {
          idSet.add(ev.id);
          deduped.push(ev);
        }
      }

      seenEventIdsRef.current = idSet;
      eventsCountRef.current = deduped.length;
      setFeedState({ teamId, events: deduped });
      nextCursorRef.current = response.pagination?.nextCursor || null;
      hasMoreRef.current = Boolean(response.pagination?.hasMore);
      setHasMore(Boolean(response.pagination?.hasMore));
    } catch (err) {
      if (gen !== requestGenerationRef.current || teamIdRef.current !== teamId || !isMountedRef.current) return;
      setError(formatErrorMessage(err));
    } finally {
      if (gen === requestGenerationRef.current && isMountedRef.current) {
        isLoadingInitialRef.current = false;
        setIsLoadingInitial(false);
      }
    }
  }, []);

  /**
   * Refreshes the feed via native pull-to-refresh.
   * Clears existing cursor, resets hasMore, and restarts pagination from page 1.
   * NOTE: Decoupled from events.length to ensure stable identity for useFocusEffect.
   */
  const handleRefresh = useCallback(async () => {
    const currentTeamId = selectedTeam?.id;
    if (!currentTeamId || isRefreshingRef.current) return;

    const gen = ++requestGenerationRef.current;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setPaginationError(null);

    try {
      const response = await activityService.getTeamActivity(currentTeamId, { limit: PAGE_SIZE });

      if (gen !== requestGenerationRef.current || teamIdRef.current !== currentTeamId || !isMountedRef.current) {
        return;
      }

      const receivedEvents = response.events || [];
      const idSet = new Set<string>();
      const deduped: ActivityEvent[] = [];

      for (const ev of receivedEvents) {
        if (!idSet.has(ev.id)) {
          idSet.add(ev.id);
          deduped.push(ev);
        }
      }

      seenEventIdsRef.current = idSet;
      eventsCountRef.current = deduped.length;
      setFeedState({ teamId: currentTeamId, events: deduped });
      nextCursorRef.current = response.pagination?.nextCursor || null;
      hasMoreRef.current = Boolean(response.pagination?.hasMore);
      setHasMore(Boolean(response.pagination?.hasMore));
      setError(null);
    } catch (err) {
      if (gen !== requestGenerationRef.current || teamIdRef.current !== currentTeamId || !isMountedRef.current) return;
      // If we already have items rendered, preserve them and show pagination error banner
      if (eventsCountRef.current === 0) {
        setError(formatErrorMessage(err));
      } else {
        setPaginationError(formatErrorMessage(err));
      }
    } finally {
      if (gen === requestGenerationRef.current && isMountedRef.current) {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    }
  }, [selectedTeam?.id]);

  /**
   * Fetches the next page of activity events using keyset cursor pagination.
   */
  const handleLoadMore = useCallback(async () => {
    const currentCursor = nextCursorRef.current;
    const currentTeamId = selectedTeam?.id;

    if (
      !currentTeamId ||
      isLoadingInitialRef.current ||
      isRefreshingRef.current ||
      isFetchingMoreRef.current ||
      !hasMoreRef.current ||
      !currentCursor
    ) {
      return;
    }

    const gen = requestGenerationRef.current;
    isFetchingMoreRef.current = true;
    setIsFetchingMore(true);
    setPaginationError(null);

    try {
      const response = await activityService.getTeamActivity(currentTeamId, {
        limit: PAGE_SIZE,
        cursor: currentCursor,
      });

      if (gen !== requestGenerationRef.current || teamIdRef.current !== currentTeamId || !isMountedRef.current) {
        return;
      }

      const receivedEvents = response.events || [];
      const newItems: ActivityEvent[] = [];

      for (const ev of receivedEvents) {
        if (!seenEventIdsRef.current.has(ev.id)) {
          seenEventIdsRef.current.add(ev.id);
          newItems.push(ev);
        }
      }

      setFeedState((prev) => {
        if (prev.teamId !== currentTeamId) return prev;
        const updated = [...prev.events, ...newItems];
        eventsCountRef.current = updated.length;
        return { teamId: currentTeamId, events: updated };
      });
      nextCursorRef.current = response.pagination?.nextCursor || null;
      hasMoreRef.current = Boolean(response.pagination?.hasMore);
      setHasMore(Boolean(response.pagination?.hasMore));
    } catch (err) {
      if (gen !== requestGenerationRef.current || teamIdRef.current !== currentTeamId || !isMountedRef.current) return;
      setPaginationError('Failed to load older activity. Tap to retry.');
    } finally {
      if (gen === requestGenerationRef.current && isMountedRef.current) {
        isFetchingMoreRef.current = false;
        setIsFetchingMore(false);
      }
    }
  }, [selectedTeam?.id]);

  // Team switching: reset feed immediately and trigger reload for new team
  useEffect(() => {
    const currentTeamId = selectedTeam?.id;
    teamIdRef.current = currentTeamId || null;

    if (!currentTeamId) {
      setFeedState({ teamId: null, events: [] });
      eventsCountRef.current = 0;
      seenEventIdsRef.current.clear();
      nextCursorRef.current = null;
      hasMoreRef.current = false;
      setHasMore(false);
      setError(null);
      setPaginationError(null);
      setIsLoadingInitial(false);
      return;
    }

    // Synchronously clear feed state for the previous team and clear errors
    setFeedState({ teamId: currentTeamId, events: [] });
    eventsCountRef.current = 0;
    seenEventIdsRef.current.clear();
    nextCursorRef.current = null;
    hasMoreRef.current = false;
    setHasMore(false);
    setError(null);
    setPaginationError(null);

    loadInitialFeed(currentTeamId);
  }, [selectedTeam?.id, loadInitialFeed]);

  // Focus effect: Refresh when returning to screen, avoiding duplicate loops
  useFocusEffect(
    useCallback(() => {
      if (
        selectedTeam?.id &&
        !isLoadingInitialRef.current &&
        !isRefreshingRef.current &&
        !isFetchingMoreRef.current
      ) {
        handleRefresh();
      }
    }, [selectedTeam?.id, handleRefresh])
  );

  const renderItem = useCallback(({ item }: ListRenderItemInfo<ActivityEvent>) => {
    return <ActivityItem event={item} />;
  }, []);

  const keyExtractor = useCallback((item: ActivityEvent) => item.id, []);

  // Header component with navigation back button and workspace badge
  const ListHeader = useMemo(() => {
    return (
      <View style={styles.headerContainer}>
        <View style={styles.topNavRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to schedule"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>← Back to Schedule</Text>
          </Pressable>
        </View>

        <BrandHeader
          badge="WORKSPACE AUDIT"
          title={selectedTeam?.name || 'Team Activity'}
          subtitle="Chronological audit history of schedule and team mutations"
        />

        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>ACTIVITY FEED</Text>
          <Text style={styles.timezoneNotice}>
            Showing times in {Intl.DateTimeFormat().resolvedOptions().timeZone || 'local timezone'}
          </Text>
        </View>
      </View>
    );
  }, [router, selectedTeam?.name]);

  // Empty state handling
  const ListEmpty = useMemo(() => {
    if (error) {
      return (
        <View style={[styles.stateCard, styles.errorCard]}>
          <Text style={styles.errorTitle}>Unable to Load Activity</Text>
          <Text style={styles.errorText}>{error}</Text>
          <ActionButton
            label="Retry"
            onPress={() => selectedTeam?.id && loadInitialFeed(selectedTeam.id)}
            variant="primary"
            size="small"
            style={styles.retryButton}
          />
        </View>
      );
    }

    if (isLoadingInitial || (selectedTeam?.id && feedState.teamId !== selectedTeam.id)) {
      return (
        <View style={styles.stateCard}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.stateTitle}>Loading activity feed...</Text>
          <Text style={styles.stateSubtitle}>Retrieving team audit logs</Text>
        </View>
      );
    }

    return (
      <View style={styles.stateCard}>
        <Text style={styles.stateTitle}>No Activity Yet</Text>
        <Text style={styles.stateSubtitle}>
          When team members schedule shifts, modify assignments, or propose shift swaps, events will appear here in real time.
        </Text>
      </View>
    );
  }, [isLoadingInitial, error, selectedTeam?.id, feedState.teamId, loadInitialFeed]);

  // Footer state handling
  const ListFooter = useMemo(() => {
    if (isFetchingMore) {
      return (
        <View style={styles.footerContainer}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.footerText}>Loading older activity...</Text>
        </View>
      );
    }

    if (paginationError) {
      return (
        <View style={styles.footerContainer}>
          <Text style={styles.paginationErrorText}>{paginationError}</Text>
          <Pressable accessibilityRole="button" onPress={handleLoadMore} style={styles.retryLink}>
            <Text style={styles.retryLinkText}>Tap to Retry ↻</Text>
          </Pressable>
        </View>
      );
    }

    if (!hasMore && visibleEvents.length > 0) {
      return (
        <View style={styles.footerContainer}>
          <Text style={styles.endOfFeedText}>— End of activity history —</Text>
          <Text style={styles.endOfFeedSubtext}>All events have been loaded</Text>
        </View>
      );
    }

    return <View style={styles.footerSpacer} />;
  }, [isFetchingMore, paginationError, hasMore, visibleEvents.length, handleLoadMore]);

  return (
    <View style={styles.container}>
      <FlatList
        data={visibleEvents}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        ListFooterComponent={ListFooter}
        contentContainerStyle={styles.listContent}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  headerContainer: {
    paddingTop: Platform.OS === 'ios' ? spacing.md : spacing.lg,
    paddingBottom: spacing.sm,
  },
  topNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  backButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
    backgroundColor: '#EEF2FF',
  },
  backButtonText: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
  eyebrowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  timezoneNotice: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  timestamp: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    fontWeight: '500',
  },
  eventTitle: {
    fontSize: typography.sizes.md,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 2,
  },
  eventDescription: {
    fontSize: typography.sizes.sm,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  metadataContainer: {
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  metadataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  metadataLabel: {
    fontSize: typography.sizes.xs,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  metadataValue: {
    fontSize: typography.sizes.xs,
    fontWeight: '500',
    color: colors.text,
  },
  stateCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  errorCard: {
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  stateTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  stateSubtitle: {
    fontSize: typography.sizes.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  errorTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    color: '#991B1B',
    marginBottom: spacing.xs,
  },
  errorText: {
    fontSize: typography.sizes.sm,
    color: '#B91C1C',
    textAlign: 'center',
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  retryButton: {
    minWidth: 120,
  },
  footerContainer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    marginTop: spacing.xs,
  },
  footerSpacer: {
    height: spacing.md,
  },
  paginationErrorText: {
    color: colors.error,
    fontSize: typography.sizes.xs,
    marginBottom: spacing.xs,
  },
  retryLink: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  retryLinkText: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
  endOfFeedText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  endOfFeedSubtext: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
});
