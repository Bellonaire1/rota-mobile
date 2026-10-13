import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { BrandHeader } from '@/components/common/BrandHeader';
import { colors, spacing, typography } from '@/constants/theme';
import { APP_CONFIG } from '@/constants/config';
import { useHealthCheck } from '@/hooks/useHealthCheck';

export const HomeScreen: React.FC = () => {
  const { data, loading, error, check } = useHealthCheck(false);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <BrandHeader
          title={APP_CONFIG.appName}
          subtitle={APP_CONFIG.tagline}
        />

        <View style={styles.divider} />

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Backend Base URL:</Text>
          <Text style={styles.sectionValue} numberOfLines={2}>
            {APP_CONFIG.apiBaseUrl}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.button}
          onPress={check}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.buttonText}>Check Backend Health</Text>
          )}
        </TouchableOpacity>

        {data && (
          <View style={[styles.resultCard, styles.successCard]}>
            <Text style={styles.resultTitle}>Status: {data.status.toUpperCase()}</Text>
            <Text style={styles.resultDetail}>{data.message}</Text>
            <Text style={styles.resultTimestamp}>Server time: {data.timestamp}</Text>
          </View>
        )}

        {error && (
          <View style={[styles.resultCard, styles.errorCard]}>
            <Text style={styles.resultErrorTitle}>Connection Error</Text>
            <Text style={styles.resultDetail}>{error}</Text>
          </View>
        )}
      </View>

      <Text style={styles.footerNote}>Rota Shift Scheduling • Graduation Project</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.xl,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  section: {
    marginBottom: spacing.lg,
    padding: spacing.sm,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
  },
  sectionLabel: {
    fontSize: typography.sizes.xs,
    fontWeight: '700',
    color: colors.textSecondary,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionValue: {
    fontSize: typography.sizes.sm,
    color: colors.text,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: typography.sizes.md,
    fontWeight: '600',
  },
  resultCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
  },
  successCard: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  errorCard: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  resultTitle: {
    fontSize: typography.sizes.sm,
    fontWeight: '700',
    color: '#065F46',
  },
  resultErrorTitle: {
    fontSize: typography.sizes.sm,
    fontWeight: '700',
    color: '#991B1B',
  },
  resultDetail: {
    fontSize: typography.sizes.xs,
    color: colors.text,
    marginTop: 4,
  },
  resultTimestamp: {
    fontSize: typography.sizes.xs,
    color: colors.textSecondary,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  footerNote: {
    marginTop: spacing.xl,
    fontSize: typography.sizes.xs,
    color: colors.textSecondary,
  },
});
