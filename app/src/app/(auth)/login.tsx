import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/common/ActionButton';
import { BrandHeader } from '@/components/common/BrandHeader';
import { FormField } from '@/components/common/FormField';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/services/api/apiClient';
import { colors, spacing, typography } from '@/constants/theme';

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/(app)/select-team');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Unable to sign in. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandHeader badge="ROTA" subtitle="Your team, in rhythm" />
        <View style={styles.card}>
          <Text style={styles.eyebrow}>WELCOME BACK</Text>
          <Text style={styles.title}>Sign in to Rota</Text>
          <Text style={styles.subtitle}>See today's schedule and keep your team moving.</Text>
          <View style={styles.form}>
            <FormField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="you@example.com" />
            <FormField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" placeholder="Your password" />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <ActionButton label="Sign in" onPress={submit} loading={loading} />
          </View>
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.switchText}>New to Rota?</Text>
          <Pressable onPress={() => router.push('/(auth)/register')}><Text style={styles.link}>Create an account</Text></Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: { width: '100%', maxWidth: 460, alignSelf: 'center', backgroundColor: colors.card, borderRadius: 22, padding: spacing.xl, borderWidth: 1, borderColor: colors.border },
  eyebrow: { color: colors.primaryLight, fontSize: typography.sizes.xs, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: typography.sizes.xl, fontWeight: '800', marginTop: spacing.sm },
  subtitle: { color: colors.textSecondary, fontSize: typography.sizes.sm, lineHeight: 21, marginTop: spacing.xs },
  form: { marginTop: spacing.xl },
  error: { color: colors.error, fontSize: typography.sizes.sm, marginBottom: spacing.md },
  switchRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xs, marginTop: spacing.lg },
  switchText: { color: colors.textSecondary, fontSize: typography.sizes.sm },
  link: { color: colors.primary, fontSize: typography.sizes.sm, fontWeight: '700' },
});
