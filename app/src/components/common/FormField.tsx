import React from 'react';
import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { colors, spacing, typography } from '@/constants/theme';

interface FormFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

export function FormField({ label, error, ...props }: FormFieldProps) {
  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, error && styles.inputError]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.md },
  label: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700', marginBottom: spacing.xs },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 13, paddingHorizontal: spacing.md, color: colors.text, backgroundColor: '#FFFFFF', fontSize: typography.sizes.md },
  inputError: { borderColor: colors.error },
  error: { color: colors.error, fontSize: typography.sizes.xs, marginTop: spacing.xs },
});
