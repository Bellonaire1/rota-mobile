import { Redirect, useRouter } from 'expo-router';
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
import { shiftService } from '@/services/api/shiftService';
import { teamService } from '@/services/api/teamService';
import { Shift, ShiftStatus, TeamMember, TeamRole } from '@/types/api';

type StatusFilter = 'ALL' | ShiftStatus;

interface ShiftFormState {
  title: string;
  assignedToUserId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

const todayInput = () => {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const timeInput = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const dateFromInput = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3])
    ? date
    : null;
};

const localOffsetIso = (date: Date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
};

const dateTimeFromInputs = (dateValue: string, timeValue: string): Date | null => {
  const date = dateFromInput(dateValue);
  const time = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!date || !time || Number(time[1]) > 23 || Number(time[2]) > 59) return null;
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(time[1]), Number(time[2]));
  return result.getHours() === Number(time[1]) && result.getMinutes() === Number(time[2]) ? result : null;
};

const displayName = (member: TeamMember) => member.user.name || member.user.email;

const shiftDisplay = (shift: Shift) => {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const date = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} \u2022 ${startTime} \u2013 ${endTime}`;
};

const formForShift = (shift: Shift): ShiftFormState => {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  return {
    title: shift.title,
    assignedToUserId: shift.assignedToUserId,
    startDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    startTime: timeInput(start),
    endDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
    endTime: timeInput(end),
  };
};

const emptyForm = (assigneeId = ''): ShiftFormState => {
  const date = todayInput();
  return { title: '', assignedToUserId: assigneeId, startDate: date, startTime: '09:00', endDate: date, endTime: '17:00' };
};

export default function DashboardScreen() {
  const router = useRouter();
  const { user, selectedTeam, signOut, isPersistenceAvailable } = useAuth();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [role, setRole] = useState<TeamRole | null>(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [dateDraft, setDateDraft] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const [error, setError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingShift, setEditingShift] = useState<Shift | null>(null);
  const [form, setForm] = useState<ShiftFormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const canManage = role === 'OWNER' || role === 'MANAGER';
  const hasMore = pagination.page < pagination.totalPages;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

  const loadShifts = useCallback(async (reset = true) => {
    if (!selectedTeam) return;
    if (filterDate && !dateFromInput(filterDate)) {
      setError('Use a valid filter date in YYYY-MM-DD format.');
      return;
    }
    if (reset) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const page = reset ? 1 : pageRef.current + 1;
      const fromDate = filterDate ? dateFromInput(filterDate) : null;
      const toDate = fromDate ? new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + 1) : null;
      const response = await shiftService.list(selectedTeam.id, {
        page,
        limit: 20,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        from: fromDate ? localOffsetIso(fromDate) : undefined,
        to: toDate ? localOffsetIso(toDate) : undefined,
      });
      setShifts((current) => reset ? response.shifts : [...current, ...response.shifts]);
      pageRef.current = response.pagination.page;
      setPagination({ page: response.pagination.page, totalPages: response.pagination.totalPages });
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to load the schedule.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [filterDate, selectedTeam, statusFilter]);

  const loadMembers = useCallback(async () => {
    if (!selectedTeam || !user) return;
    setMemberError(null);
    try {
      const currentMembers = await teamService.listAllMembers(selectedTeam.id);
      setMembers(currentMembers);
      setRole(currentMembers.find((member) => member.userId === user.id)?.role ?? null);
    } catch (requestError) {
      setMemberError(requestError instanceof ApiError ? requestError.message : 'Unable to load team members.');
      setRole(null);
    }
  }, [selectedTeam, user]);

  useEffect(() => { loadShifts(true); }, [loadShifts]);
  useEffect(() => { loadMembers(); }, [loadMembers]);

  const openCreate = () => {
    setEditingShift(null);
    setForm(emptyForm(members[0]?.userId ?? ''));
    setFormError(null);
    setModalVisible(true);
  };

  const openEdit = (shift: Shift) => {
    setEditingShift(shift);
    setForm(formForShift(shift));
    setFormError(null);
    setModalVisible(true);
  };

  const updateForm = (field: keyof ShiftFormState, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const saveShift = async () => {
    const title = form.title.trim();
    const start = dateTimeFromInputs(form.startDate, form.startTime);
    const end = dateTimeFromInputs(form.endDate, form.endTime);
    if (!title) return setFormError('A shift title is required.');
    if (!form.assignedToUserId) return setFormError('Choose a team member to assign this shift.');
    if (!start || !end) return setFormError('Use valid dates and times.');
    if (end <= start) return setFormError('The end must be after the start.');
    if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) return setFormError('A shift cannot exceed 24 hours.');
    if (!selectedTeam) return;

    setSaving(true);
    setFormError(null);
    const input = {
      title,
      assignedToUserId: form.assignedToUserId,
      startsAt: localOffsetIso(start),
      endsAt: localOffsetIso(end),
    };
    try {
      if (editingShift) {
        await shiftService.update(selectedTeam.id, editingShift.id, { ...input, updatedAt: editingShift.updatedAt });
      } else {
        await shiftService.create(selectedTeam.id, input);
      }
      setModalVisible(false);
      await loadShifts(true);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.statusCode === 409) {
        setFormError(`${requestError.message} Refresh the schedule and try again.`);
        await loadShifts(true);
      } else {
        setFormError(requestError instanceof ApiError ? requestError.message : 'Unable to save this shift.');
      }
    } finally {
      setSaving(false);
    }
  };

  const cancelShift = (shift: Shift) => {
    Alert.alert('Cancel shift?', `Cancel "${shift.title}" for ${shift.assignedTo.name || shift.assignedTo.email}?`, [
      { text: 'Keep shift', style: 'cancel' },
      {
        text: 'Cancel shift',
        style: 'destructive',
        onPress: async () => {
          if (!selectedTeam) return;
          setCancellingId(shift.id);
          setError(null);
          try {
            await shiftService.cancel(selectedTeam.id, shift.id, shift.updatedAt);
            await loadShifts(true);
          } catch (requestError) {
            setError(requestError instanceof ApiError && requestError.statusCode === 409
              ? `${requestError.message} The schedule was refreshed.`
              : requestError instanceof ApiError ? requestError.message : 'Unable to cancel this shift.');
            if (requestError instanceof ApiError && requestError.statusCode === 409) await loadShifts(true);
          } finally {
            setCancellingId(null);
          }
        },
      },
    ]);
  };

  const applyDateFilter = () => {
    if (dateDraft && !dateFromInput(dateDraft)) {
      setError('Use a valid filter date in YYYY-MM-DD format.');
      return;
    }
    setError(null);
    setFilterDate(dateDraft);
  };

  const sortedShifts = useMemo(() => [...shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [shifts]);

  if (!selectedTeam) {
    return <Redirect href="/(app)/select-team" />;
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadShifts(true); }} tintColor={colors.primary} />}
    >
      <BrandHeader badge="WORKSPACE" title={selectedTeam.name} subtitle={`Schedule · ${role ? role.toLowerCase() : 'team member'}`} />
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>TEAM SCHEDULE</Text>
          <Text style={styles.title}>Shifts</Text>
        </View>
        {canManage ? <ActionButton size="small" label="Add shift" onPress={openCreate} /> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.push('/(app)/members')} style={styles.membersLink}>
        <Text style={styles.membersLinkText}>View team members →</Text>
      </Pressable>

      <View style={styles.filterCard}>
        <Text style={styles.filterTitle}>Find shifts</Text>
        <FormField label="Date (optional)" value={dateDraft} onChangeText={setDateDraft} placeholder="YYYY-MM-DD" autoCapitalize="none" accessibilityHint="Filter shifts to one local calendar day" />
        <View style={styles.filterActions}>
          <ActionButton label="Apply date" onPress={applyDateFilter} variant="secondary" />
          {filterDate ? <ActionButton label="Clear" onPress={() => { setDateDraft(''); setFilterDate(''); }} variant="quiet" /> : null}
        </View>
        <Text style={styles.timezone}>Times shown in {timezone}.</Text>
        <View style={styles.segmentRow}>
          {(['ALL', 'SCHEDULED', 'CANCELLED'] as StatusFilter[]).map((status) => (
            <Pressable key={status} accessibilityRole="button" accessibilityState={{ selected: statusFilter === status }} onPress={() => setStatusFilter(status)} style={[styles.segment, statusFilter === status && styles.segmentSelected]}>
              <Text style={[styles.segmentLabel, statusFilter === status && styles.segmentLabelSelected]}>{status === 'ALL' ? 'All' : status === 'SCHEDULED' ? 'Scheduled' : 'Cancelled'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {memberError ? <Text style={styles.warning}>{memberError} Management controls are unavailable.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : sortedShifts.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{statusFilter === 'CANCELLED' ? 'No cancelled shifts' : 'No shifts found'}</Text>
          <Text style={styles.muted}>{canManage ? 'Create the first shift or adjust the filters.' : 'Your team has no shifts matching these filters.'}</Text>
          {canManage ? <ActionButton label="Create a shift" onPress={openCreate} /> : null}
        </View>
      ) : (
        <View>
          {sortedShifts.map((shift) => (
            <View key={shift.id} style={[styles.shiftCard, shift.status === 'CANCELLED' && styles.cancelledCard]}>
              <View style={styles.shiftTopRow}>
                <View style={styles.shiftTitleWrap}>
                  <Text style={styles.shiftTitle}>{shift.title}</Text>
                  <Text style={styles.shiftDate}>{shiftDisplay(shift)}</Text>
                </View>
                <Text style={[styles.status, shift.status === 'CANCELLED' && styles.cancelledStatus]}>{shift.status === 'SCHEDULED' ? 'Scheduled' : 'Cancelled'}</Text>
              </View>
              <Text style={styles.assignee}>Assigned to {shift.assignedTo.name || shift.assignedTo.email}</Text>
              {canManage && shift.status === 'SCHEDULED' ? (
                <View style={styles.shiftActions}>
                  <ActionButton size="small" label="Edit" onPress={() => openEdit(shift)} variant="secondary" />
                  <ActionButton size="small" label={cancellingId === shift.id ? 'Cancelling...' : 'Cancel'} onPress={() => cancelShift(shift)} variant="quiet" loading={cancellingId === shift.id} />
                </View>
              ) : null}
            </View>
          ))}
          {hasMore ? <ActionButton label={loadingMore ? 'Loading...' : 'Load more'} onPress={() => loadShifts(false)} loading={loadingMore} variant="secondary" /> : null}
        </View>
      )}

      {!isPersistenceAvailable ? <Text style={styles.notice}>Secure session persistence is unavailable on this platform. You will need to sign in again after closing the app.</Text> : null}
      <View style={styles.bottomActions}>
        <ActionButton label="Change team" onPress={() => router.push('/(app)/select-team')} variant="secondary" />
        <ActionButton label="Sign out" onPress={signOut} variant="quiet" />
      </View>

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.eyebrow}>{editingShift ? 'UPDATE SHIFT' : 'NEW SHIFT'}</Text>
                  <Text style={styles.modalTitle}>{editingShift ? 'Edit shift' : 'Create a shift'}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close shift form" onPress={() => setModalVisible(false)}><Text style={styles.close}>Close</Text></Pressable>
              </View>
              <FormField label="Title" value={form.title} onChangeText={(value) => updateForm('title', value)} placeholder="Front desk cover" maxLength={200} />
              <Text style={styles.formLabel}>Assignee</Text>
              <View style={styles.assigneeContainer}>
                {members.length === 0 ? <Text style={styles.muted}>No team members are available to assign.</Text> : members.map((member) => (
                  <Pressable key={member.userId} accessibilityRole="radio" accessibilityState={{ checked: form.assignedToUserId === member.userId }} onPress={() => updateForm('assignedToUserId', member.userId)} style={[styles.assigneeOption, form.assignedToUserId === member.userId && styles.assigneeSelected]}>
                    <Text style={styles.assigneeOptionName}>{displayName(member)}</Text>
                    <Text style={styles.assigneeOptionRole}>{member.role}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.twoColumns}>
                <View style={styles.column}><FormField label="Start date" value={form.startDate} onChangeText={(value) => updateForm('startDate', value)} placeholder="YYYY-MM-DD" autoCapitalize="none" /></View>
                <View style={styles.column}><FormField label="Start time" value={form.startTime} onChangeText={(value) => updateForm('startTime', value)} placeholder="09:00" keyboardType="numbers-and-punctuation" /></View>
              </View>
              <View style={styles.twoColumns}>
                <View style={styles.column}><FormField label="End date" value={form.endDate} onChangeText={(value) => updateForm('endDate', value)} placeholder="YYYY-MM-DD" autoCapitalize="none" /></View>
                <View style={styles.column}><FormField label="End time" value={form.endTime} onChangeText={(value) => updateForm('endTime', value)} placeholder="17:00" keyboardType="numbers-and-punctuation" /></View>
              </View>
              <Text style={styles.timezone}>Local times are sent with the device UTC offset.</Text>
              {formError ? <Text style={styles.error}>{formError}</Text> : null}
              <ActionButton label={editingShift ? 'Save changes' : 'Create shift'} onPress={saveShift} loading={saving} disabled={!canManage} />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: spacing.md },
  membersLink: { alignSelf: 'flex-start', marginBottom: spacing.md },
  membersLinkText: { color: colors.primary, fontSize: typography.sizes.sm, fontWeight: '700' },
  eyebrow: { color: colors.accent, fontSize: typography.sizes.xs, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: typography.sizes.xxl, fontWeight: '800', marginTop: spacing.xs },
  filterCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: spacing.md, marginBottom: spacing.md },
  filterTitle: { color: colors.text, fontSize: typography.sizes.md, fontWeight: '800', marginBottom: spacing.sm },
  filterActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  timezone: { color: colors.textSecondary, fontSize: typography.sizes.xs, marginBottom: spacing.sm },
  segmentRow: { flexDirection: 'row', gap: spacing.xs },
  segment: { flex: 1, borderRadius: 10, paddingVertical: spacing.sm, alignItems: 'center', backgroundColor: colors.background },
  segmentSelected: { backgroundColor: colors.primary },
  segmentLabel: { color: colors.textSecondary, fontSize: typography.sizes.xs, fontWeight: '700' },
  segmentLabelSelected: { color: '#FFFFFF' },
  shiftCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: spacing.md, marginBottom: spacing.sm },
  cancelledCard: { opacity: 0.7 },
  shiftTopRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  shiftTitleWrap: { flex: 1 },
  shiftTitle: { color: colors.text, fontSize: typography.sizes.lg, fontWeight: '800' },
  shiftDate: { color: colors.primary, fontSize: typography.sizes.sm, fontWeight: '700', marginTop: spacing.xs },
  status: { color: colors.success, fontSize: typography.sizes.xs, fontWeight: '800', textTransform: 'uppercase' },
  cancelledStatus: { color: colors.textSecondary },
  assignee: { color: colors.textSecondary, fontSize: typography.sizes.sm, marginTop: spacing.md },
  shiftActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  loader: { marginVertical: spacing.xl },
  emptyCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: spacing.lg, marginBottom: spacing.md },
  emptyTitle: { color: colors.text, fontSize: typography.sizes.lg, fontWeight: '800', marginBottom: spacing.xs },
  muted: { color: colors.textSecondary, fontSize: typography.sizes.sm, lineHeight: 21, marginBottom: spacing.md },
  error: { color: colors.error, fontSize: typography.sizes.sm, lineHeight: 20, marginBottom: spacing.md },
  warning: { color: colors.warning, fontSize: typography.sizes.sm, lineHeight: 20, marginBottom: spacing.md },
  notice: { color: colors.textSecondary, fontSize: typography.sizes.xs, lineHeight: 18, textAlign: 'center', marginVertical: spacing.md },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalScroll: { flexGrow: 1, justifyContent: 'flex-end' },
  modalCard: { backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg, paddingBottom: spacing.xxl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.lg },
  modalTitle: { color: colors.text, fontSize: typography.sizes.xl, fontWeight: '800', marginTop: spacing.xs },
  close: { color: colors.primary, fontWeight: '700', paddingVertical: spacing.xs },
  formLabel: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700', marginBottom: spacing.xs },
  assigneeOption: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: spacing.sm, marginBottom: spacing.xs, flexDirection: 'row', justifyContent: 'space-between' },
  assigneeSelected: { borderColor: colors.primary, backgroundColor: '#EEF2FF' },
  assigneeOptionName: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700' },
  assigneeOptionRole: { color: colors.textSecondary, fontSize: typography.sizes.xs },
  twoColumns: { flexDirection: 'row', gap: spacing.sm },
  column: { flex: 1 },
  assigneeContainer: { maxHeight: 180, marginBottom: spacing.sm },
  bottomActions: { marginTop: spacing.xl, gap: spacing.sm },
});
