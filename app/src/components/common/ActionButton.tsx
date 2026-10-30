import React from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors, spacing, typography } from '@/constants/theme';

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet';
  size?: 'normal' | 'small';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ActionButton({
  label,
  onPress,
  loading = false,
  variant = 'primary',
  size = 'normal',
  disabled = false,
  style,
}: ActionButtonProps) {
  const isSmall = size === 'small';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        isSmall && styles.small,
        (disabled || loading) && styles.disabled,
        pressed && !disabled && !loading && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size={isSmall ? 'small' : undefined}
          color={variant === 'primary' ? '#FFFFFF' : colors.primary}
        />
      ) : (
        <Text
          style={[
            styles.label,
            variant === 'primary' ? styles.primaryLabel : styles.secondaryLabel,
            isSmall && styles.smallLabel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, borderRadius: 14, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  small: { minHeight: 38, borderRadius: 10, paddingHorizontal: spacing.md },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  quiet: { backgroundColor: 'transparent', minHeight: 42 },
  label: { fontSize: typography.sizes.md, fontWeight: '700' },
  smallLabel: { fontSize: typography.sizes.sm },
  primaryLabel: { color: '#FFFFFF' },
  secondaryLabel: { color: colors.primary },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.82 },
});
