import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
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
import { authService } from '@/services/api/authService';
import { ApiError } from '@/services/api/apiClient';
import { colors, spacing, typography } from '@/constants/theme';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  
  // Accept optional token from deep link / query param, otherwise empty for manual entry
  const [token, setToken] = useState(params.token ? String(params.token).trim() : '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const validate = (): boolean => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setError('Enter your password reset token.');
      return false;
    }
    if (password.length < 8) {
      setError('New password must be at least 8 characters.');
      return false;
    }
    if (password.length > 128) {
      setError('New password must not exceed 128 characters.');
      return false;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (loading) return;
    setError(null);

    if (!validate()) {
      return;
    }

    setLoading(true);
    try {
      await authService.confirmPasswordReset({
        token: token.trim(),
        password,
      });

      // Clear sensitive form state from memory immediately upon success
      setToken('');
      setPassword('');
      setConfirmPassword('');
      setSuccess(true);
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        if (requestError.statusCode === 400) {
          setError(
            'This reset token is invalid, has expired, or has already been used. Please request a new one.'
          );
        } else if (requestError.statusCode === 429) {
          setError('Too many attempts. Please wait a few minutes before trying again.');
        } else if (requestError.statusCode === 0) {
          setError('Network request failed. Please check your connection and try again.');
        } else {
          setError(requestError.message || 'Unable to reset password. Please try again.');
        }
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandHeader badge="SECURITY" subtitle="Account recovery" />
        <View style={styles.card}>
          <Text style={styles.eyebrow}>SET NEW PASSWORD</Text>
          <Text style={styles.title}>Create new password</Text>
          <Text style={styles.subtitle}>
            Enter the reset token sent to your email and choose a strong replacement password.
          </Text>

          {success ? (
            <View style={styles.successBox}>
              <View style={styles.successIconWrapper}>
                <Text style={styles.successIcon}>✓</Text>
              </View>
              <Text style={styles.successTitle}>Password updated</Text>
              <Text style={styles.successText}>
                Your password has been reset successfully. Any active login sessions will expire shortly,
                and new sign-ins must use your new password. Please sign in to continue.
              </Text>
              <ActionButton
                label="Sign in"
                onPress={() => router.replace('/(auth)/login')}
                style={styles.successAction}
              />
            </View>
          ) : (
            <View style={styles.form}>
              <FormField
                label="Reset token"
                value={token}
                onChangeText={(val) => {
                  setToken(val);
                  if (error) setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Paste 64-character token"
                editable={!loading}
              />
              <FormField
                label="New password"
                value={password}
                onChangeText={(val) => {
                  setPassword(val);
                  if (error) setError(null);
                }}
                secureTextEntry
                autoComplete="new-password"
                placeholder="At least 8 characters"
                editable={!loading}
              />
              <FormField
                label="Confirm new password"
                value={confirmPassword}
                onChangeText={(val) => {
                  setConfirmPassword(val);
                  if (error) setError(null);
                }}
                secureTextEntry
                autoComplete="new-password"
                placeholder="Re-enter your new password"
                editable={!loading}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <ActionButton
                label="Reset password"
                onPress={submit}
                loading={loading}
                disabled={loading}
              />
              <View style={styles.requestNewRow}>
                <Text style={styles.requestNewText}>Need a new token?</Text>
                <Pressable
                  onPress={() => router.replace('/(auth)/forgot-password')}
                  accessibilityRole="button"
                  accessibilityLabel="Request a new reset link"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.inlineButton}
                >
                  <Text style={styles.link}>Request reset link</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.switchText}>Remember your password?</Text>
          <Pressable
            onPress={() => router.replace('/(auth)/login')}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.inlineButton}
          >
            <Text style={styles.link}>Sign in</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    width: '100%',
    maxWidth: 460,
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
  form: { marginTop: spacing.xl },
  error: { color: colors.error, fontSize: typography.sizes.sm, marginBottom: spacing.md },
  successBox: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    backgroundColor: '#F0FDF4',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#BBF7D0',
    alignItems: 'center',
  },
  successIconWrapper: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#DCFCE7',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  successIcon: {
    color: colors.success,
    fontSize: 22,
    fontWeight: '800',
  },
  successTitle: {
    color: colors.text,
    fontSize: typography.sizes.lg,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  successText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  successAction: {
    width: '100%',
  },
  requestNewRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  requestNewText: { color: colors.textSecondary, fontSize: typography.sizes.sm },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  switchText: { color: colors.textSecondary, fontSize: typography.sizes.sm },
  inlineButton: { minHeight: 44, justifyContent: 'center' },
  link: { color: colors.primary, fontSize: typography.sizes.sm, fontWeight: '700' },
});

