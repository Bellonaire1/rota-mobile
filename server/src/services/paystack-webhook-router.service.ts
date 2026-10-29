import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingPaymentAttemptStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../database/prisma';
import {
  PAYSTACK_CUSTOMER_CODE_PATTERN,
  PAYSTACK_SUBSCRIPTION_CODE_PATTERN,
} from '../billing/payments';

export const PAYSTACK_PROVIDER = 'paystack';
export const CHARGE_SUCCESS_EVENT = 'charge.success';
export const SUBSCRIPTION_CREATE_EVENT = 'subscription.create';
export const INVOICE_UPDATE_EVENT = 'invoice.update';
export const INVOICE_PAYMENT_FAILED_EVENT = 'invoice.payment_failed';

export type WebhookRouterDatabase = PrismaClient | Prisma.TransactionClient | any;

export interface WebhookEventInput {
  id: string;
  provider: string;
  eventType: string;
  payload: unknown;
}

export type PaystackWebhookClassification =
  | {
      readonly route: 'INITIAL_CHECKOUT_RECONCILIATION';
      readonly reference: string;
      readonly paymentAttemptId: string;
      readonly subscriptionId: string;
      readonly isRecurring: boolean;
    }
  | {
      readonly route: 'RENEWAL_PAYMENT_REPLAY';
      readonly reference: string;
      readonly paymentAttemptId: string;
      readonly subscriptionId: string;
      readonly invoiceId: string;
    }
  | {
      readonly route: 'UNRESOLVED_CHARGE_AMBIGUOUS';
      readonly reference: string;
      readonly reason: string;
    }
  | {
      readonly route: 'SUBSCRIPTION_CREATE_LINKAGE';
      readonly subscriptionCode: string;
      readonly customerCode: string;
      readonly localSubscriptionId?: string;
    }
  | {
      readonly route: 'SUBSCRIPTION_CREATE_UNRECOGNIZED';
      readonly subscriptionCode: string;
      readonly customerCode: string;
      readonly reason: string;
    }
  | {
      readonly route: 'RENEWAL_INVOICE_UPDATE';
      readonly subscriptionCode: string;
      readonly invoiceCode: string;
      readonly transactionReference?: string;
      readonly isPaid: boolean;
      readonly localSubscriptionId?: string;
    }
  | {
      readonly route: 'RENEWAL_PAYMENT_FAILED';
      readonly subscriptionCode: string;
      readonly customerCode?: string;
      readonly invoiceCode?: string;
      readonly localSubscriptionId?: string;
    }
  | {
      readonly route: 'UNSUPPORTED_EVENT_TYPE';
      readonly eventType: string;
      readonly reason: string;
    }
  | {
      readonly route: 'MALFORMED_EVENT_PAYLOAD';
      readonly reason: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export class PaystackWebhookRouter {
  constructor(private readonly database: WebhookRouterDatabase = defaultPrisma) {}

  async classify(event: WebhookEventInput): Promise<PaystackWebhookClassification> {
    if (!event || typeof event !== 'object') {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'Event object is undefined or invalid' };
    }

    if (event.provider !== PAYSTACK_PROVIDER) {
      return {
        route: 'UNSUPPORTED_EVENT_TYPE',
        eventType: event.eventType ?? 'unknown',
        reason: `Unsupported provider: ${event.provider}; expected ${PAYSTACK_PROVIDER}`,
      };
    }

    if (!isRecord(event.payload)) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'Webhook payload is not an object' };
    }

    switch (event.eventType) {
      case CHARGE_SUCCESS_EVENT:
        return this.classifyChargeSuccess(event.payload);

      case SUBSCRIPTION_CREATE_EVENT:
        return this.classifySubscriptionCreate(event.payload);

      case INVOICE_UPDATE_EVENT:
        return this.classifyInvoiceUpdate(event.payload);

      case INVOICE_PAYMENT_FAILED_EVENT:
        return this.classifyInvoicePaymentFailed(event.payload);

      default:
        return {
          route: 'UNSUPPORTED_EVENT_TYPE',
          eventType: event.eventType,
          reason: `Event type ${event.eventType} is not supported by Paystack billing router`,
        };
    }
  }

  private async classifyChargeSuccess(payload: Record<string, unknown>): Promise<PaystackWebhookClassification> {
    const data = isRecord(payload.data) ? payload.data : null;
    if (!data) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'charge.success missing payload data object' };
    }

    const rawRef = data.reference;
    if (typeof rawRef !== 'string' || rawRef.trim().length === 0) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'charge.success missing valid payment reference string' };
    }
    const reference = rawRef.trim();

    // 1. Check for stored PaymentAttempt matching providerReference
    const attempt = await this.database.billingPaymentAttempt.findUnique({
      where: { providerReference: reference },
      include: {
        idempotencyRecord: true,
        invoice: {
          include: {
            subscription: true,
          },
        },
      },
    });

    if (attempt) {
      // Check if attempt belongs to an initial checkout
      const scope = attempt.idempotencyRecord?.scope;
      const isCheckoutScope = typeof scope === 'string' && scope.startsWith('team-billing-checkout:');

      if (isCheckoutScope && attempt.invoice?.subscriptionId) {
        let isRecurring = false;
        const responseBody = attempt.idempotencyRecord?.responseBody;
        if (isRecord(responseBody)) {
          isRecurring = responseBody.recurring === true;
        } else if (typeof responseBody === 'string') {
          try {
            const parsed = JSON.parse(responseBody);
            if (isRecord(parsed)) isRecurring = parsed.recurring === true;
          } catch {
            isRecurring = false;
          }
        }

        return {
          route: 'INITIAL_CHECKOUT_RECONCILIATION',
          reference,
          paymentAttemptId: attempt.id,
          subscriptionId: attempt.invoice.subscriptionId,
          isRecurring,
        };
      }

      // Check if attempt represents a confirmed renewal payment replay
      if (
        attempt.status === BillingPaymentAttemptStatus.SUCCEEDED &&
        attempt.invoice?.status === BillingInvoiceStatus.PAID &&
        attempt.providerPaymentId &&
        attempt.invoice.subscriptionId
      ) {
        const externalReference = `paystack:payment:${attempt.providerPaymentId}`;
        const ledger = this.database.billingLedgerTransaction
          ? await this.database.billingLedgerTransaction.findUnique({ where: { externalReference } })
          : null;

        if (ledger && ledger.status === BillingLedgerTransactionStatus.POSTED) {
          return {
            route: 'RENEWAL_PAYMENT_REPLAY',
            reference,
            paymentAttemptId: attempt.id,
            subscriptionId: attempt.invoice.subscriptionId,
            invoiceId: attempt.invoiceId,
          };
        }
      }
    }

    // 2. Fall-through: Payment reference is not linked to an initial checkout attempt
    // and does not match a confirmed renewal replay.
    // Fail closed: Unknown or unresolved charges must remain explicitly unresolved
    // and never silently marked as settled or completed.
    return {
      route: 'UNRESOLVED_CHARGE_AMBIGUOUS',
      reference,
      reason: 'No stored checkout attempt or confirmed renewal payment pairing matches provider reference',
    };
  }

  private async classifySubscriptionCreate(payload: Record<string, unknown>): Promise<PaystackWebhookClassification> {
    const data = isRecord(payload.data) ? payload.data : null;
    if (!data) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'subscription.create missing payload data object' };
    }

    const rawSubCode = typeof data.subscription_code === 'string'
      ? data.subscription_code
      : (typeof data.subscriptionCode === 'string' ? data.subscriptionCode : undefined);

    if (!rawSubCode || !PAYSTACK_SUBSCRIPTION_CODE_PATTERN.test(rawSubCode)) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'subscription.create missing valid subscription_code' };
    }
    const subscriptionCode = rawSubCode.trim();

    let rawCustomerCode: string | undefined;
    if (isRecord(data.customer) && typeof data.customer.customer_code === 'string') {
      rawCustomerCode = data.customer.customer_code;
    } else if (isRecord(data.customer) && typeof data.customer.customerCode === 'string') {
      rawCustomerCode = data.customer.customerCode;
    } else if (typeof data.customer_code === 'string') {
      rawCustomerCode = data.customer_code;
    }

    if (!rawCustomerCode || !PAYSTACK_CUSTOMER_CODE_PATTERN.test(rawCustomerCode)) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'subscription.create missing valid customer_code' };
    }
    const customerCode = rawCustomerCode.trim();

    // Look up local subscription by providerSubscriptionId or providerCustomerId
    let subscription = await this.database.billingSubscription.findUnique({
      where: { providerSubscriptionId: subscriptionCode },
    });

    if (!subscription) {
      subscription = await this.database.billingSubscription.findUnique({
        where: { providerCustomerId: customerCode },
      });
    }

    if (subscription) {
      return {
        route: 'SUBSCRIPTION_CREATE_LINKAGE',
        subscriptionCode,
        customerCode,
        localSubscriptionId: subscription.id,
      };
    }

    return {
      route: 'SUBSCRIPTION_CREATE_UNRECOGNIZED',
      subscriptionCode,
      customerCode,
      reason: 'No stored subscription matches provider subscription code or customer code',
    };
  }

  private async classifyInvoiceUpdate(payload: Record<string, unknown>): Promise<PaystackWebhookClassification> {
    const data = isRecord(payload.data) ? payload.data : null;
    if (!data) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'invoice.update missing payload data object' };
    }

    // Extract subscription code
    let subscriptionCode: string | undefined;
    if (isRecord(data.subscription) && typeof data.subscription.subscription_code === 'string') {
      subscriptionCode = data.subscription.subscription_code;
    } else if (typeof data.subscription_code === 'string') {
      subscriptionCode = data.subscription_code;
    }

    if (!subscriptionCode || !PAYSTACK_SUBSCRIPTION_CODE_PATTERN.test(subscriptionCode)) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'invoice.update missing valid subscription_code' };
    }

    // Extract invoice code
    const rawInvoiceCode = typeof data.invoice_code === 'string'
      ? data.invoice_code
      : (typeof data.invoiceCode === 'string' ? data.invoiceCode : undefined);

    if (!rawInvoiceCode || rawInvoiceCode.trim().length === 0) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'invoice.update missing valid invoice_code' };
    }
    const invoiceCode = rawInvoiceCode.trim();

    // Extract transaction reference if present
    let transactionReference: string | undefined;
    if (isRecord(data.transaction) && typeof data.transaction.reference === 'string') {
      transactionReference = data.transaction.reference.trim();
    } else if (typeof data.reference === 'string') {
      transactionReference = data.reference.trim();
    }

    // Evaluate paid status
    const isPaid = (data.paid === true) && (data.status === 'paid' || data.status === 'success');

    // Look up local subscription
    const subscription = await this.database.billingSubscription.findUnique({
      where: { providerSubscriptionId: subscriptionCode },
    });

    return {
      route: 'RENEWAL_INVOICE_UPDATE',
      subscriptionCode,
      invoiceCode,
      transactionReference,
      isPaid,
      localSubscriptionId: subscription?.id,
    };
  }

  private async classifyInvoicePaymentFailed(payload: Record<string, unknown>): Promise<PaystackWebhookClassification> {
    const data = isRecord(payload.data) ? payload.data : null;
    if (!data) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'invoice.payment_failed missing payload data object' };
    }

    // Extract subscription code
    let subscriptionCode: string | undefined;
    if (isRecord(data.subscription) && typeof data.subscription.subscription_code === 'string') {
      subscriptionCode = data.subscription.subscription_code;
    } else if (typeof data.subscription_code === 'string') {
      subscriptionCode = data.subscription_code;
    }

    if (!subscriptionCode || !PAYSTACK_SUBSCRIPTION_CODE_PATTERN.test(subscriptionCode)) {
      return { route: 'MALFORMED_EVENT_PAYLOAD', reason: 'invoice.payment_failed missing valid subscription_code' };
    }

    // Extract customer code
    let customerCode: string | undefined;
    if (isRecord(data.customer) && typeof data.customer.customer_code === 'string') {
      customerCode = data.customer.customer_code;
    } else if (typeof data.customer_code === 'string') {
      customerCode = data.customer_code;
    }

    // Extract invoice code
    const rawInvoiceCode = typeof data.invoice_code === 'string' ? data.invoice_code : undefined;
    const invoiceCode = rawInvoiceCode?.trim();

    const subscription = await this.database.billingSubscription.findUnique({
      where: { providerSubscriptionId: subscriptionCode },
    });

    return {
      route: 'RENEWAL_PAYMENT_FAILED',
      subscriptionCode,
      customerCode,
      invoiceCode,
      localSubscriptionId: subscription?.id,
    };
  }
}
