import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
import { teamInvitationService } from '@/services/api/teamInvitationService';
import { teamService } from '@/services/api/teamService';
import { pendingInvitationStorage } from '@/services/pendingInvitation';
import { InvitationPreview, Team } from '@/types/api';

const TOKEN_REGEX = /^[a-f0-9]{64}$/i;

export default function InviteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { user, selectTeam, signOut, isLoading: authLoading } = useAuth();

  const [tokenInput, setTokenInput] = useState<string>(
    params.token ? String(params.token).trim() : ''
  );
  const [activeToken, setActiveToken] = useState<string | null>(
    params.token && TOKEN_REGEX.test(String(params.token).trim())
      ? String(params.token).trim()
      : null
  );

  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptSuccess, setAcceptSuccess] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  // Sync param changes if user opens link with a new token
  useEffect(() => {
    if (params.token) {
      const trimmed = String(params.token).trim();
      setTokenInput(trimmed);
      if (TOKEN_REGEX.test(trimmed)) {
        setActiveToken(trimmed);
        setInputError(null);
      } else {
        setActiveToken(null);
        setInputError('Invitation code must be a 64-character hexadecimal token.');
      }
    }
  }, [params.token]);

  // When activeToken changes and user is unauthenticated, preserve token in storage
  useEffect(() => {
    if (activeToken && !user && !authLoading) {
      pendingInvitationStorage.savePendingToken(activeToken);
    }
  }, [activeToken, user, authLoading]);

  // Fetch preview when authenticated and activeToken is present
  const fetchPreview = useCallback(async (tokenToPreview: string) => {
    setLoadingPreview(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const data = await teamInvitationService.preview(tokenToPreview);
      setPreview(data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 404) {
          setPreviewError('This invitation could not be found or the code is invalid.');
        } else if (err.statusCode === 403) {
          setPreviewError(
            err.message || 'This invitation was issued to a different email address.'
          );
        } else if (err.statusCode === 400) {
          if (err.message?.toLowerCase().includes('expired')) {
            setPreviewError('This invitation has expired. Please request a new invitation from the team owner.');
          } else if (err.message?.toLowerCase().includes('revoked')) {
            setPreviewError('This invitation has been revoked by the team owner.');
          } else if (err.message?.toLowerCase().includes('already been accepted')) {
            setPreviewError('This invitation has already been accepted.');
          } else {
            setPreviewError(err.message || 'This invitation is no longer valid.');
          }
        } else {
          setPreviewError(err.message || 'Unable to load invitation details. Please try again.');
        }
      } else {
        setPreviewError('Network error. Please check your internet connection.');
      }
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  useEffect(() => {
    if (activeToken && user && !authLoading) {
      fetchPreview(activeToken);
    }
  }, [activeToken, user, authLoading, fetchPreview]);

  // Handle manual code entry
  const handleLookupManualToken = () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setInputError('Please enter an invitation code.');
      return;
    }
    if (!TOKEN_REGEX.test(trimmed)) {
      setInputError('Invitation code must be a 64-character hexadecimal token.');
      return;
    }
    setInputError(null);
    setActiveToken(trimmed);
  };

  // Handle accepting the invitation
  const handleAccept = async () => {
    if (!activeToken || !user) return;
    setAccepting(true);
    setPreviewError(null);
    try {
      const result = await teamInvitationService.accept(activeToken);
      setAcceptSuccess(true);
      await pendingInvitationStorage.clearPendingToken();

      // Refresh user's teams and select the newly joined team
      try {
        const { teams } = await teamService.list();
        const joinedTeam = teams.find((t) => t.id === result.team.id) ?? {
          id: result.team.id,
          name: result.team.name,
          createdByUserId: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await selectTeam(joinedTeam);
      } catch {
        // Fallback team selection
        await selectTeam({
          id: result.team.id,
          name: result.team.name,
          createdByUserId: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      // Navigate to app workspace
      router.replace('/(app)');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          if (err.message?.includes('already a member')) {
            setPreviewError('You are already a member of this team.');
          } else {
            setPreviewError(err.message || 'This invitation has already been accepted or is no longer valid.');
          }
        } else if (err.statusCode === 403) {
          setPreviewError(
            err.message || 'Authenticated email does not match invitation recipient.'
          );
        } else {
          setPreviewError(err.message || 'Failed to accept invitation. Please try again.');
        }
      } else {
        setPreviewError('Failed to accept invitation. Please check your connection.');
      }
    } finally {
      setAccepting(false);
    }
  };

  const handleSignOutToSwitch = async () => {
    if (activeToken) {
      await pendingInvitationStorage.savePendingToken(activeToken);
    }
    await signOut();
  };

  const isEmailMismatch =
    user && preview && user.email.toLowerCase() !== preview.invitedEmail.toLowerCase();

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandHeader badge="INVITATION" subtitle="Join your team on Rota" />

        {authLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>Checking session...</Text>
          </View>
        ) : !activeToken ? (
          /* Manual Code Entry Form */
          <View style={styles.card}>
            <Text style={styles.eyebrow}>TEAM INVITATION</Text>
            <Text style={styles.title}>Enter Invitation Code</Text>
            <Text style={styles.subtitle}>
              Paste or enter the 64-character invitation code from your email.
            </Text>

            <View style={styles.form}>
              <FormField
                label="Invitation Code"
                value={tokenInput}
                onChangeText={(text) => {
                  setTokenInput(text);
                  if (inputError) setInputError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="e.g. 4a8f9c0b..."
              />
              {inputError ? <Text style={styles.error}>{inputError}</Text> : null}
              <ActionButton
                label="Continue"
                onPress={handleLookupManualToken}
              />
            </View>

            {user ? (
              <View style={styles.secondaryActions}>
                <ActionButton
                  label="Back to teams"
                  variant="quiet"
                  onPress={() => router.replace('/(app)/select-team')}
                />
              </View>
            ) : (
              <View style={styles.secondaryActions}>
                <ActionButton
                  label="Back to sign in"
                  variant="quiet"
                  onPress={() => router.replace('/(auth)/login')}
                />
              </View>
            )}
          </View>
        ) : !user ? (
          /* Unauthenticated State — token captured, prompt sign-in/register */
          <View style={styles.card}>
            <Text style={styles.eyebrow}>YOU'VE BEEN INVITED</Text>
            <Text style={styles.title}>Join your team on Rota</Text>
            <Text style={styles.subtitle}>
              We received your invitation code. Please sign in or create an account to preview and accept your invitation.
            </Text>

            <View style={styles.codeSnippetBox}>
              <Text style={styles.codeSnippetLabel}>INVITATION CODE</Text>
              <Text selectable style={styles.codeSnippetText} numberOfLines={1} ellipsizeMode="middle">
                {activeToken}
              </Text>
            </View>

            <View style={styles.form}>
              <ActionButton
                label="Sign In"
                onPress={() => router.push('/(auth)/login')}
              />
              <ActionButton
                label="Create Account"
                variant="secondary"
                onPress={() => router.push('/(auth)/register')}
              />
              <ActionButton
                label="Sign In with Email Link"
                variant="quiet"
                onPress={() => router.push('/(auth)/magic-link')}
              />
            </View>

            <View style={styles.switchRow}>
              <Pressable
                onPress={() => {
                  setActiveToken(null);
                  setTokenInput('');
                }}
              >
                <Text style={styles.link}>Enter a different code</Text>
              </Pressable>
            </View>
          </View>
        ) : loadingPreview ? (
          /* Authenticated — Loading Preview */
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>Loading invitation details...</Text>
          </View>
        ) : previewError ? (
          /* Authenticated — Preview or Accept Error */
          <View style={styles.card}>
            <Text style={styles.eyebrowError}>INVITATION ERROR</Text>
            <Text style={styles.title}>Unable to accept</Text>
            <Text style={styles.errorBox}>{previewError}</Text>

            <View style={styles.form}>
              <ActionButton
                label="Try Again"
                variant="secondary"
                onPress={() => fetchPreview(activeToken)}
              />
              <ActionButton
                label="Enter a different code"
                variant="quiet"
                onPress={() => {
                  setActiveToken(null);
                  setTokenInput('');
                  setPreviewError(null);
                }}
              />
              <ActionButton
                label="Go to my teams"
                variant="quiet"
                onPress={() => router.replace('/(app)/select-team')}
              />
            </View>
          </View>
        ) : preview ? (
          /* Authenticated — Invitation Preview Screen */
          <View style={styles.card}>
            <Text style={styles.eyebrow}>TEAM INVITATION</Text>
            <Text style={styles.title}>{preview.teamName}</Text>
            <Text style={styles.subtitle}>
              {preview.inviterName} has invited you to join this team.
            </Text>

            <View style={styles.detailsCard}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Role</Text>
                <View style={styles.roleBadge}>
                  <Text style={styles.roleBadgeText}>{preview.role}</Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Invited Email</Text>
                <Text style={styles.detailValue}>{preview.invitedEmail}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expires</Text>
                <Text style={styles.detailValue}>
                  {new Date(preview.expiresAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </Text>
              </View>

              <View style={styles.divider} />

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Signed in as</Text>
                <Text style={styles.detailValueBold}>{user.email}</Text>
              </View>
            </View>

            {isEmailMismatch ? (
              <View style={styles.mismatchBox}>
                <Text style={styles.mismatchTitle}>Email Mismatch</Text>
                <Text style={styles.mismatchText}>
                  This invitation was sent to{' '}
                  <Text style={styles.bold}>{preview.invitedEmail}</Text>, but you are
                  signed in as <Text style={styles.bold}>{user.email}</Text>. Please
                  switch to the invited account to accept.
                </Text>
                <ActionButton
                  label="Sign out & Switch account"
                  variant="secondary"
                  onPress={handleSignOutToSwitch}
                />
              </View>
            ) : (
              <View style={styles.form}>
                <ActionButton
                  label={accepting ? 'Joining...' : `Join ${preview.teamName}`}
                  onPress={handleAccept}
                  loading={accepting}
                  disabled={acceptSuccess}
                />
                <ActionButton
                  label="Dismiss"
                  variant="quiet"
                  onPress={() => router.replace('/(app)/select-team')}
                  disabled={accepting}
                />
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.md,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    fontWeight: '600',
  },
  card: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  eyebrow: {
    color: colors.primaryLight,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  eyebrowError: {
    color: colors.error,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  title: {
    color: colors.text,
    fontSize: typography.sizes.xl,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 21,
    marginTop: spacing.xs,
  },
  form: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  secondaryActions: {
    marginTop: spacing.md,
  },
  codeSnippetBox: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  codeSnippetLabel: {
    color: colors.textSecondary,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: spacing.xs,
  },
  codeSnippetText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: typography.sizes.xs,
    color: colors.primaryDark,
    fontWeight: '700',
  },
  detailsCard: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    fontWeight: '600',
  },
  detailValue: {
    color: colors.text,
    fontSize: typography.sizes.sm,
    fontWeight: '600',
  },
  detailValueBold: {
    color: colors.text,
    fontSize: typography.sizes.sm,
    fontWeight: '800',
  },
  roleBadge: {
    backgroundColor: '#DBEAFE',
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  roleBadgeText: {
    color: colors.primary,
    fontSize: typography.sizes.xs,
    fontWeight: '800',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  mismatchBox: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 14,
    padding: spacing.md,
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  mismatchTitle: {
    color: '#991B1B',
    fontSize: typography.sizes.sm,
    fontWeight: '800',
  },
  mismatchText: {
    color: '#7F1D1D',
    fontSize: typography.sizes.sm,
    lineHeight: 20,
  },
  bold: {
    fontWeight: '800',
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    color: colors.error,
    fontSize: typography.sizes.sm,
    lineHeight: 20,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  error: {
    color: colors.error,
    fontSize: typography.sizes.sm,
    marginBottom: spacing.xs,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  link: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
});
