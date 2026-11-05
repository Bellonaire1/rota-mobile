import { focusManager } from '@tanstack/react-query';

export interface AppStateSubscription {
  remove: () => void;
}

export interface AppStateSource {
  addEventListener: (
    type: any,
    listener: (state: any) => void
  ) => AppStateSubscription;
}

/**
 * Registers React Native AppState listener with TanStack Query's focusManager
 * so backgrounded apps pause queries and returning to foreground triggers refetch
 * for stale queries.
 *
 * Accepts AppState source and platform flag from the host application.
 *
 * @returns teardown cleanup function
 */
export function setupQueryFocusManager(
  appStateSource: AppStateSource,
  isNativePlatform = true
): () => void {
  let subscriptionRemove: (() => void) | undefined;

  focusManager.setEventListener((handleFocus) => {
    const subscription = appStateSource.addEventListener('change', (status) => {
      if (isNativePlatform) {
        focusManager.setFocused(status === 'active');
      }
    });

    subscriptionRemove = () => {
      subscription.remove();
    };

    return () => {
      subscription.remove();
    };
  });

  return () => {
    subscriptionRemove?.();
  };
}
