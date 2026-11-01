import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
} from 'react-native';
import { colors, spacing, typography } from '@/constants/theme';

export interface FormFieldProps extends TextInputProps {
  label: string;
  error?: string;
  showPasswordToggle?: boolean;
}

interface EyeIconProps {
  visible: boolean;
  color?: string;
}

function EyeIcon({ visible, color = colors.textSecondary }: EyeIconProps) {
  return (
    <View style={eyeStyles.container} pointerEvents="none">
      <View style={[eyeStyles.almond, { borderColor: color }]}>
        <View style={[eyeStyles.pupil, { backgroundColor: color }]} />
      </View>
      {!visible && (
        <>
          <View style={eyeStyles.slashUnderlay} />
          <View style={[eyeStyles.slash, { backgroundColor: color }]} />
        </>
      )}
    </View>
  );
}

const eyeStyles = StyleSheet.create({
  container: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  almond: {
    width: 14,
    height: 14,
    borderTopLeftRadius: 14,
    borderBottomRightRadius: 14,
    borderWidth: 1.8,
    transform: [{ rotate: '45deg' }],
    alignItems: 'center',
    justifyContent: 'center',
  },
  pupil: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  slashUnderlay: {
    position: 'absolute',
    width: 22,
    height: 3.5,
    backgroundColor: '#FFFFFF',
    transform: [{ rotate: '-45deg' }],
  },
  slash: {
    position: 'absolute',
    width: 22,
    height: 1.8,
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }],
  },
});

export const FormField = React.forwardRef<TextInput, FormFieldProps>(
  function FormField(
    {
      label,
      error,
      showPasswordToggle,
      secureTextEntry,
      style,
      autoCapitalize,
      autoCorrect,
      testID,
      ...props
    },
    ref
  ) {
    const isPasswordField = showPasswordToggle ?? Boolean(secureTextEntry);
    const [isPasswordVisible, setIsPasswordVisible] = useState(false);

    const effectiveSecureTextEntry = isPasswordField
      ? !isPasswordVisible
      : Boolean(secureTextEntry);

    const toggleTestId = testID
      ? `${testID}-toggle`
      : `${label.toLowerCase().replace(/\s+/g, '-')}-toggle`;

    return (
      <View style={styles.wrapper}>
        <Text style={styles.label}>{label}</Text>
        <View style={[styles.inputContainer, Boolean(error) && styles.inputError]}>
          <TextInput
            ref={ref}
            {...props}
            testID={testID}
            secureTextEntry={effectiveSecureTextEntry}
            autoCapitalize={autoCapitalize ?? (isPasswordField ? 'none' : undefined)}
            autoCorrect={autoCorrect ?? (isPasswordField ? false : undefined)}
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              isPasswordField && styles.inputWithToggle,
              style,
            ]}
          />
          {isPasswordField && (
            <Pressable
              onPress={() => setIsPasswordVisible((prev) => !prev)}
              style={styles.toggleButton}
              accessibilityRole="button"
              accessibilityLabel={isPasswordVisible ? 'Hide password' : 'Show password'}
              accessibilityHint={
                isPasswordVisible
                  ? 'Hides password characters'
                  : 'Displays password in plain text'
              }
              accessibilityState={{ checked: isPasswordVisible }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              testID={toggleTestId}
            >
              <EyeIcon visible={isPasswordVisible} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }
);

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.md },
  label: { color: colors.text, fontSize: typography.sizes.sm, fontWeight: '700', marginBottom: spacing.xs },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
  },
  input: {
    flex: 1,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: typography.sizes.md,
  },
  inputWithToggle: {
    paddingRight: spacing.xs,
  },
  toggleButton: {
    width: 48,
    height: 48,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 2,
  },
  inputError: { borderColor: colors.error },
  error: { color: colors.error, fontSize: typography.sizes.xs, marginTop: spacing.xs },
});
