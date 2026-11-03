import { useRouter } from 'expo-router';
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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function MagicLinkRequestScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const validate = (): boolean => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email address.');
      return false;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      setError('Enter a valid email address.');
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
      await authService.requestMagicLink({ email: email.trim().toLowerCase() });
      setSubmitted(true);
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        if (requestError.statusCode === 429) {
          setError('Too many sign-in requests. Please wait a few minutes before trying again.');
        } else if (requestError.statusCode === 500) {
          setError('Unable to send sign-in email at this time. Please try again later.');
        } else if (requestError.statusCode === 0) {
          setError('Network request failed. Please check your connection and try again.');
        } else {
          setError(requestError.message || 'Unable to process your request. Try again.');
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
        <BrandHeader badge="PASSWORDLESS" subtitle="Instant access" />
        <View style={styles.card}>
          <Text style={styles.eyebrow}>PASSWORDLESS SIGN-IN</Text>
          <Text style={styles.title}>Sign in with email</Text>
          <Text style={styles.subtitle}>
            Enter your email and we'll send a sign-in code and magic link to access your account without a password.
          </Text>

          {submitted ? (
            <View style={styles.confirmationBox}>
              <View style={styles.successIconWrapper}>
                <Text style={styles.successIcon}>✓</Text>
              </View>
              <Text style={styles.confirmationTitle}>Check your email</Text>
              <Text style={styles.confirmationText}>
                If an account exists with that email, a sign-in link and one-time code have been sent.
                Please check your inbox and spam folder.
              </Text>
              <View style={styles.confirmationActions}>
                <ActionButton
                  label="Enter sign-in code"
                  onPress={() => router.push('/(auth)/magic-link-confirm')}
                />
                <ActionButton
                  label="Back to sign in"
                  variant="secondary"
                  onPress={() => router.replace('/(auth)/login')}
                  style={styles.secondaryAction}
                />
              </View>
            </View>
          ) : (
            <View style={styles.form}>
              <FormField
                label="Email"
                value={email}
                onChangeText={(val) => {
                  setEmail(val);
                  if (error) setError(null);
                }}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                placeholder="you@example.com"
                editable={!loading}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <ActionButton
                label="Send sign-in link"
                onPress={submit}
                loading={loading}
                disabled={loading}
              />
              <View style={styles.tokenNoticeRow}>
                <Text style={styles.tokenNoticeText}>Already have a sign-in code?</Text>
                <Pressable
                  onPress={() => router.push('/(auth)/magic-link-confirm')}
                  accessibilityRole="button"
                  accessibilityLabel="Enter sign-in code"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.inlineButton}
                >
                  <Text style={styles.link}>Enter code</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.switchText}>Prefer using your password?</Text>
          <Pressable
            onPress={() => router.replace('/(auth)/login')}
            accessibilityRole="button"
            accessibilityLabel="Sign in with password"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.link}>Sign in with password</Text>
          </Pressable>
        </View>
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
  form: {
    marginTop: spacing.xl,
  },
  error: {
    color: colors.error,
    fontSize: typography.sizes.sm,
    marginBottom: spacing.md,
  },
  confirmationBox: {
    marginTop: spacing.xl,
    alignItems: 'center',
    padding: spacing.md,
    backgroundColor: colors.background,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  successIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.success + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  successIcon: {
    color: colors.success,
    fontSize: 24,
    fontWeight: 'bold',
  },
  confirmationTitle: {
    color: colors.text,
    fontSize: typography.sizes.lg,
    fontWeight: '700',
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  confirmationText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  confirmationActions: {
    width: '100%',
    gap: spacing.sm,
  },
  secondaryAction: {
    marginTop: spacing.xs,
  },
  tokenNoticeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  tokenNoticeText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
  },
  inlineButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  switchText: {
    color: colors.textSecondary,
    fontSize: typography.sizes.sm,
  },
  link: {
    color: colors.primary,
    fontSize: typography.sizes.sm,
    fontWeight: '700',
  },
});

