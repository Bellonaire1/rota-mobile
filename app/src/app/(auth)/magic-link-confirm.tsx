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
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import { pendingInvitationStorage } from '@/services/pendingInvitation';
import { colors, spacing, typography } from '@/constants/theme';

export default function MagicLinkConfirmScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { signInWithMagicLink } = useAuth();

  const [token, setToken] = useState(params.token ? String(params.token).trim() : '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const validate = (): boolean => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setError('Enter your sign-in code.');
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
      await signInWithMagicLink(token.trim());
      // Clear token from memory immediately upon success
      setToken('');
      const pendingToken = await pendingInvitationStorage.getPendingToken();
      if (pendingToken) {
        router.replace({ pathname: '/invite', params: { token: pendingToken } });
      } else {
        router.replace('/(app)/select-team');
      }
    } catch (requestError) {
      if (requestError instanceof ApiError) {
        if (requestError.statusCode === 400) {
          setError(
            'This sign-in code is invalid, has expired, or has already been used. Please request a new one.'
          );
        } else if (requestError.statusCode === 429) {
          setError('Too many attempts. Please wait a few minutes before trying again.');
        } else if (requestError.statusCode === 0) {
          setError('Network request failed. Please check your connection and try again.');
        } else {
          setError(requestError.message || 'Unable to sign in. Please try again.');
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
        <BrandHeader badge="SIGN IN" subtitle="Instant verification" />
        <View style={styles.card}>
          <Text style={styles.eyebrow}>PASSWORDLESS VERIFICATION</Text>
          <Text style={styles.title}>Enter sign-in code</Text>
          <Text style={styles.subtitle}>
            Enter the one-time sign-in code sent to your email to access your account.
          </Text>

          <View style={styles.form}>
            <FormField
              label="Sign-in code"
              value={token}
              onChangeText={(val) => {
                setToken(val);
                if (error) setError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Paste 64-character code"
              editable={!loading}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <ActionButton
              label="Sign in"
              onPress={submit}
              loading={loading}
              disabled={loading}
            />

            <View style={styles.helpRow}>
              <Text style={styles.helpText}>Need a new code?</Text>
              <Pressable
                onPress={() => router.push('/(auth)/magic-link')}
                accessibilityRole="button"
                accessibilityLabel="Request a new sign-in link"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.inlineButton}
              >
                <Text style={styles.link}>Request link</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.switchText}>Remember your password?</Text>
          <Pressable
            onPress={() => router.replace('/(auth)/login')}
            accessibilityRole="button"
            accessibilityLabel="Sign in with password"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.link}>Sign in</Text>
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
  helpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  helpText: {
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

