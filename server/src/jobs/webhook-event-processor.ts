export interface WebhookEventProcessor {
  process(event: { id: string; provider: string; eventType: string; payload: unknown }): Promise<void>;
}

export class RetryableWebhookError extends Error {}

export class PermanentWebhookError extends Error {}

export class WebhookProcessorNotConfiguredError extends Error {
  constructor() {
    super('Webhook worker startup refused: approved payment-reconciliation processor is not configured; genuine Paystack events remain RECEIVED until Task 5D.3');
    this.name = 'WebhookProcessorNotConfiguredError';
  }
}

/**
 * Financial Paystack dispatch is deliberately unavailable until Task 5D.3.
 * A real worker therefore fails closed instead of acknowledging an event.
 */
export class FailClosedWebhookEventProcessor implements WebhookEventProcessor {
  async process(_event: { id: string; provider: string; eventType: string; payload: unknown }): Promise<void> {
    throw new WebhookProcessorNotConfiguredError();
  }
}

export const assertApprovedWebhookProcessor = (processor: WebhookEventProcessor): void => {
  if (processor instanceof FailClosedWebhookEventProcessor) throw new WebhookProcessorNotConfiguredError();
};
