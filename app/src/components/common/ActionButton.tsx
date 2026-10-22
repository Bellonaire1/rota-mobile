import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, spacing, typography } from '@/constants/theme';

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
}

export function ActionButton({ label, onPress, loading = false, variant = 'primary', disabled = false }: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        (disabled || loading) && styles.disabled,
        pressed && !disabled && !loading && styles.pressed,
      ]}
    >
      {loading ? <ActivityIndicator color={variant === 'primary' ? '#FFFFFF' : colors.primary} /> : <Text style={[styles.label, variant === 'primary' ? styles.primaryLabel : styles.secondaryLabel]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, borderRadius: 14, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  quiet: { backgroundColor: 'transparent', minHeight: 42 },
  label: { fontSize: typography.sizes.md, fontWeight: '700' },
  primaryLabel: { color: '#FFFFFF' },
  secondaryLabel: { color: colors.primary },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.82 },
});
