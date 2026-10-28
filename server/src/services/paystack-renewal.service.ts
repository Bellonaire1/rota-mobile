import {
  PAYSTACK_CUSTOMER_CODE_PATTERN,
  PAYSTACK_PLAN_CODE_PATTERN,
  PAYSTACK_SUBSCRIPTION_CODE_PATTERN,
  PAYSTACK_USD_MINIMUM_CENTS,
  type PaystackCurrency,
} from '../billing/payments';

export const SUPPORTED_RENEWAL_EVENT_TYPES = [
  'invoice.create',
  'invoice.update',
  'invoice.payment_failed',
  'charge.success',
] as const;

export type RenewalWebhookEventType = (typeof SUPPORTED_RENEWAL_EVENT_TYPES)[number];

export const PAYSTACK_INVOICE_CODE_PATTERN = /^INV_[A-Za-z0-9._:-]{3,100}$/;
export const PAYSTACK_TRANSACTION_REF_PATTERN = /^[A-Za-z0-9._:-]{3,100}$/;

const SUPPORTED_CURRENCIES = new Set<PaystackCurrency>(['USD', 'NGN', 'GHS', 'ZAR', 'KES']);

export type RenewalCycleCandidateType =
  | 'INVOICE_CODE'
  | 'INVOICE_ID'
  | 'PERIOD_BOUNDS'
  | 'TRANSACTION_ONLY'
  | 'NONE';

/**
 * Represents a preliminary candidate identifier for a recurring billing cycle,
 * extracted strictly from untrusted webhook payload hints.
 *
 * IMPORTANT SECURITY INVARIANT:
 * `hasStableCycleCandidate: true` indicates ONLY that the webhook payload supplied
 * a structurally well-formed, stable candidate identifier (e.g. provider subscription code
 * + provider invoice code/id) suitable for targeted downstream lookup/verification.
 * It does NOT establish verified payment settlement, provider cycle validity, customer
 * ownership, or active entitlement. All candidates remain UNVERIFIED hints until confirmed
 * against the provider's authoritative API and matching local billing records.
 */
export interface RenewalCycleCandidate {
  readonly candidateKey: string | null;
  readonly candidateType: RenewalCycleCandidateType;
  readonly hasStableCycleCandidate: boolean;
  readonly candidateLimitations: readonly string[];
}

export interface UntrustedRenewalSubscriptionHint {
  readonly subscriptionCode: string;
  readonly status?: string;
}

export interface UntrustedRenewalCustomerHint {
  readonly customerCode: string;
  readonly email?: string;
}

export interface UntrustedRenewalPlanHint {
  readonly planCode: string;
  readonly amountCents?: number;
  readonly currency?: PaystackCurrency;
  readonly interval?: string;
}

export interface UntrustedRenewalInvoiceHint {
  readonly invoiceCode?: string;
  readonly invoiceId?: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly paidAt?: Date;
}

export interface UntrustedRenewalTransactionHint {
  readonly reference: string;
  readonly status?: string;
  readonly amountCents?: number;
  readonly paidAt?: Date;
}

export interface UntrustedRenewalPeriodHint {
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
}

export interface UntrustedRenewalEventHint {
  readonly eventType: RenewalWebhookEventType;
  readonly provider: 'paystack';
  readonly subscription?: UntrustedRenewalSubscriptionHint;
  readonly customer?: UntrustedRenewalCustomerHint;
  readonly plan?: UntrustedRenewalPlanHint;
  readonly invoice?: UntrustedRenewalInvoiceHint;
  readonly transaction?: UntrustedRenewalTransactionHint;
  readonly period?: UntrustedRenewalPeriodHint;
  readonly amountCents?: number;
  readonly currency?: PaystackCurrency;
  readonly cycleCandidate: RenewalCycleCandidate;
}

export class MalformedRenewalHintError extends Error {
  constructor(message: string, public readonly reasonCode?: string) {
    super(message);
    this.name = 'MalformedRenewalHintError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const isSupportedRenewalEventType = (
  eventType: string
): eventType is RenewalWebhookEventType => (
  SUPPORTED_RENEWAL_EVENT_TYPES.includes(eventType as RenewalWebhookEventType)
);

const parseDateValue = (value: unknown, fieldName: string): Date | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MalformedRenewalHintError(`Invalid date object for ${fieldName}`, 'INVALID_DATE');
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new MalformedRenewalHintError(`Invalid date string for ${fieldName}: ${value}`, 'INVALID_DATE');
    }
    return parsed;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const ms = value < 100_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(ms);
    if (Number.isNaN(parsed.getTime())) {
      throw new MalformedRenewalHintError(`Invalid timestamp for ${fieldName}: ${value}`, 'INVALID_DATE');
    }
    return parsed;
  }
  throw new MalformedRenewalHintError(`Unsupported date format for ${fieldName}`, 'INVALID_DATE');
};

export const computeRenewalCycleCandidate = (
  hint: Omit<UntrustedRenewalEventHint, 'cycleCandidate'>
): RenewalCycleCandidate => {
  const candidateLimitations: string[] = [];

  if (!hint.subscription?.subscriptionCode) {
    candidateLimitations.push('MISSING_SUBSCRIPTION_IDENTITY: Event lacks a provider subscription identifier');
    return {
      candidateKey: null,
      candidateType: 'NONE',
      hasStableCycleCandidate: false,
      candidateLimitations,
    };
  }

  const subCode = hint.subscription.subscriptionCode;

  if (hint.invoice?.invoiceCode) {
    return {
      candidateKey: `${subCode}:${hint.invoice.invoiceCode}`,
      candidateType: 'INVOICE_CODE',
      hasStableCycleCandidate: true,
      candidateLimitations: [],
    };
  }

  if (hint.invoice?.invoiceId) {
    return {
      candidateKey: `${subCode}:id:${hint.invoice.invoiceId}`,
      candidateType: 'INVOICE_ID',
      hasStableCycleCandidate: true,
      candidateLimitations: [],
    };
  }

  if (hint.period?.periodStart && hint.period?.periodEnd) {
    candidateLimitations.push('UNCONFIRMED_INVOICE_IDENTITY: Cycle candidate derived solely from period bounds; lacks immutable provider invoice code');
    return {
      candidateKey: `${subCode}:period:${hint.period.periodStart.toISOString()}_${hint.period.periodEnd.toISOString()}`,
      candidateType: 'PERIOD_BOUNDS',
      hasStableCycleCandidate: false,
      candidateLimitations,
    };
  }

  if (hint.transaction?.reference) {
    candidateLimitations.push('UNCONFIRMED_CYCLE_IDENTITY: Event contains only transaction reference; cannot prove distinct billing cycle without provider invoice');
    return {
      candidateKey: `${subCode}:tx:${hint.transaction.reference}`,
      candidateType: 'TRANSACTION_ONLY',
      hasStableCycleCandidate: false,
      candidateLimitations,
    };
  }

  candidateLimitations.push('MISSING_CYCLE_IDENTITY: Event lacks provider invoice code, invoice ID, period bounds, and transaction reference');
  return {
    candidateKey: null,
    candidateType: 'NONE',
    hasStableCycleCandidate: false,
    candidateLimitations,
  };
};

export const parseRenewalEventHint = (
  payload: unknown,
  eventTypeHint?: string
): UntrustedRenewalEventHint => {
  if (!isRecord(payload)) {
    throw new MalformedRenewalHintError('Webhook payload must be a JSON object', 'INVALID_PAYLOAD');
  }

  let eventType: string | undefined;
  if (typeof payload.event === 'string' && payload.event.trim()) {
    eventType = payload.event.trim();
  } else if (typeof eventTypeHint === 'string' && eventTypeHint.trim()) {
    eventType = eventTypeHint.trim();
  }

  if (!eventType) {
    throw new MalformedRenewalHintError('Webhook payload missing event type', 'MISSING_EVENT_TYPE');
  }

  if (typeof payload.event === 'string' && eventTypeHint && payload.event !== eventTypeHint) {
    throw new MalformedRenewalHintError(
      `Contradictory event type: payload contains ${payload.event} but header specified ${eventTypeHint}`,
      'CONTRADICTORY_EVENT_TYPE'
    );
  }

  if (!isSupportedRenewalEventType(eventType)) {
    throw new MalformedRenewalHintError(`Unsupported renewal event type: ${eventType}`, 'UNSUPPORTED_EVENT_TYPE');
  }

  if (!isRecord(payload.data)) {
    throw new MalformedRenewalHintError('Webhook payload missing data object', 'MISSING_DATA');
  }

  const data = payload.data;

  // 1. Subscription identity
  let topSubCode: string | undefined;
  if (typeof data.subscription_code === 'string') {
    topSubCode = data.subscription_code.trim();
  } else if (typeof data.subscriptionCode === 'string') {
    topSubCode = data.subscriptionCode.trim();
  }

  let nestedSubCode: string | undefined;
  let subStatus: string | undefined;
  if (isRecord(data.subscription)) {
    if (typeof data.subscription.subscription_code === 'string') {
      nestedSubCode = data.subscription.subscription_code.trim();
    } else if (typeof data.subscription.subscriptionCode === 'string') {
      nestedSubCode = data.subscription.subscriptionCode.trim();
    }
    if (typeof data.subscription.status === 'string' && data.subscription.status.trim()) {
      subStatus = data.subscription.status.trim().toLowerCase();
    }
  }

  if (topSubCode && nestedSubCode && topSubCode !== nestedSubCode) {
    throw new MalformedRenewalHintError(
      `Contradictory subscription code: top-level (${topSubCode}) does not match nested (${nestedSubCode})`,
      'CONTRADICTORY_SUBSCRIPTION_CODE'
    );
  }

  const subscriptionCode = nestedSubCode ?? topSubCode;
  if (subscriptionCode !== undefined && !PAYSTACK_SUBSCRIPTION_CODE_PATTERN.test(subscriptionCode)) {
    throw new MalformedRenewalHintError(
      `Invalid subscription code format: ${subscriptionCode}`,
      'INVALID_SUBSCRIPTION_CODE'
    );
  }

  // 2. Customer identity
  let topCustomerCode: string | undefined;
  if (typeof data.customer_code === 'string') {
    topCustomerCode = data.customer_code.trim();
  } else if (typeof data.customerCode === 'string') {
    topCustomerCode = data.customerCode.trim();
  }

  let nestedCustomerCode: string | undefined;
  let customerEmail: string | undefined;
  if (isRecord(data.customer)) {
    if (typeof data.customer.customer_code === 'string') {
      nestedCustomerCode = data.customer.customer_code.trim();
    } else if (typeof data.customer.customerCode === 'string') {
      nestedCustomerCode = data.customer.customerCode.trim();
    }
    if (typeof data.customer.email === 'string' && data.customer.email.trim()) {
      customerEmail = data.customer.email.trim();
    }
  }

  let subCustomerCode: string | undefined;
  if (isRecord(data.subscription) && isRecord(data.subscription.customer)) {
    if (typeof data.subscription.customer.customer_code === 'string') {
      subCustomerCode = data.subscription.customer.customer_code.trim();
    } else if (typeof data.subscription.customer.customerCode === 'string') {
      subCustomerCode = data.subscription.customer.customerCode.trim();
    }
  }

  const distinctCustomerCodes = Array.from(
    new Set([topCustomerCode, nestedCustomerCode, subCustomerCode].filter((c): c is string => Boolean(c)))
  );
  if (distinctCustomerCodes.length > 1) {
    throw new MalformedRenewalHintError(
      `Contradictory customer codes in payload: ${distinctCustomerCodes.join(', ')}`,
      'CONTRADICTORY_CUSTOMER_CODE'
    );
  }

  const customerCode = distinctCustomerCodes[0];
  if (customerCode !== undefined && !PAYSTACK_CUSTOMER_CODE_PATTERN.test(customerCode)) {
    throw new MalformedRenewalHintError(`Invalid customer code format: ${customerCode}`, 'INVALID_CUSTOMER_CODE');
  }

  // 3. Plan identity
  let topPlanCode: string | undefined;
  if (typeof data.plan_code === 'string') {
    topPlanCode = data.plan_code.trim();
  } else if (typeof data.planCode === 'string') {
    topPlanCode = data.planCode.trim();
  }

  let nestedPlanCode: string | undefined;
  let planAmount: number | undefined;
  let planCurrency: string | undefined;
  let planInterval: string | undefined;
  if (isRecord(data.plan)) {
    if (typeof data.plan.plan_code === 'string') {
      nestedPlanCode = data.plan.plan_code.trim();
    } else if (typeof data.plan.planCode === 'string') {
      nestedPlanCode = data.plan.planCode.trim();
    }
    if (typeof data.plan.amount === 'number' && Number.isSafeInteger(data.plan.amount)) {
      planAmount = data.plan.amount;
    }
    if (typeof data.plan.currency === 'string' && data.plan.currency.trim()) {
      planCurrency = data.plan.currency.trim().toUpperCase();
    }
    if (typeof data.plan.interval === 'string' && data.plan.interval.trim()) {
      planInterval = data.plan.interval.trim().toLowerCase();
    }
  }

  let subPlanCode: string | undefined;
  if (isRecord(data.subscription) && isRecord(data.subscription.plan)) {
    if (typeof data.subscription.plan.plan_code === 'string') {
      subPlanCode = data.subscription.plan.plan_code.trim();
    } else if (typeof data.subscription.plan.planCode === 'string') {
      subPlanCode = data.subscription.plan.planCode.trim();
    }
    if (planAmount === undefined && typeof data.subscription.plan.amount === 'number' && Number.isSafeInteger(data.subscription.plan.amount)) {
      planAmount = data.subscription.plan.amount;
    }
    if (!planCurrency && typeof data.subscription.plan.currency === 'string' && data.subscription.plan.currency.trim()) {
      planCurrency = data.subscription.plan.currency.trim().toUpperCase();
    }
    if (!planInterval && typeof data.subscription.plan.interval === 'string' && data.subscription.plan.interval.trim()) {
      planInterval = data.subscription.plan.interval.trim().toLowerCase();
    }
  }

  const distinctPlanCodes = Array.from(
    new Set([topPlanCode, nestedPlanCode, subPlanCode].filter((p): p is string => Boolean(p)))
  );
  if (distinctPlanCodes.length > 1) {
    throw new MalformedRenewalHintError(
      `Contradictory plan codes in payload: ${distinctPlanCodes.join(', ')}`,
      'CONTRADICTORY_PLAN_CODE'
    );
  }

  const planCode = distinctPlanCodes[0];
  if (planCode !== undefined && !PAYSTACK_PLAN_CODE_PATTERN.test(planCode)) {
    throw new MalformedRenewalHintError(`Invalid plan code format: ${planCode}`, 'INVALID_PLAN_CODE');
  }

  // 4. Currency
  let rawCurrency: string | undefined;
  if (typeof data.currency === 'string' && data.currency.trim()) {
    rawCurrency = data.currency.trim().toUpperCase();
  }

  if (rawCurrency && planCurrency && rawCurrency !== planCurrency) {
    throw new MalformedRenewalHintError(
      `Contradictory currency: invoice currency (${rawCurrency}) does not match plan currency (${planCurrency})`,
      'CONTRADICTORY_CURRENCY'
    );
  }

  const effectiveCurrency = rawCurrency ?? planCurrency;
  if (effectiveCurrency !== undefined && !SUPPORTED_CURRENCIES.has(effectiveCurrency as PaystackCurrency)) {
    throw new MalformedRenewalHintError(`Unsupported currency: ${effectiveCurrency}`, 'UNSUPPORTED_CURRENCY');
  }

  // 5. Amount
  let amountCents: number | undefined;
  if (typeof data.amount === 'number') {
    if (!Number.isSafeInteger(data.amount) || data.amount < 0) {
      throw new MalformedRenewalHintError('Invoice amount must be a non-negative integer in cents', 'INVALID_AMOUNT');
    }
    amountCents = data.amount;
  }

  let subAmount: number | undefined;
  if (isRecord(data.subscription) && typeof data.subscription.amount === 'number') {
    if (!Number.isSafeInteger(data.subscription.amount) || data.subscription.amount < 0) {
      throw new MalformedRenewalHintError('Subscription amount must be a non-negative integer in cents', 'INVALID_AMOUNT');
    }
    subAmount = data.subscription.amount;
  }

  if (amountCents !== undefined && subAmount !== undefined && amountCents !== subAmount) {
    throw new MalformedRenewalHintError(
      `Contradictory amount: invoice amount (${amountCents}) does not match subscription amount (${subAmount})`,
      'CONTRADICTORY_AMOUNT'
    );
  }

  if (amountCents === undefined && subAmount !== undefined) {
    amountCents = subAmount;
  }

  if (effectiveCurrency === 'USD' && amountCents !== undefined && amountCents > 0 && amountCents < PAYSTACK_USD_MINIMUM_CENTS) {
    throw new MalformedRenewalHintError(
      `USD amount (${amountCents} cents) is below the Paystack minimum of ${PAYSTACK_USD_MINIMUM_CENTS} cents`,
      'AMOUNT_BELOW_MINIMUM'
    );
  }

  // 6. Invoice identity and status
  let invoiceCode: string | undefined;
  if (typeof data.invoice_code === 'string' && data.invoice_code.trim()) {
    invoiceCode = data.invoice_code.trim();
    if (!PAYSTACK_INVOICE_CODE_PATTERN.test(invoiceCode)) {
      throw new MalformedRenewalHintError(`Invalid invoice code format: ${invoiceCode}`, 'INVALID_INVOICE_CODE');
    }
  }

  let invoiceId: string | undefined;
  if (typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0) {
    invoiceId = String(data.id);
  } else if (typeof data.id === 'string' && /^\d+$/.test(data.id.trim())) {
    invoiceId = data.id.trim();
  }

  let invoiceStatus: string | undefined;
  if (typeof data.status === 'string' && data.status.trim()) {
    invoiceStatus = data.status.trim().toLowerCase();
  }

  let paid: boolean | undefined;
  if (typeof data.paid === 'boolean') {
    paid = data.paid;
  }

  const paidAt = parseDateValue(data.paid_at, 'paid_at');

  if (paid === false && paidAt) {
    throw new MalformedRenewalHintError(
      'Contradictory payment state: invoice marked paid=false cannot carry a paid_at timestamp',
      'CONTRADICTORY_PAYMENT_STATE'
    );
  }

  if (invoiceStatus === 'failed' && paid === true) {
    throw new MalformedRenewalHintError(
      'Contradictory payment state: invoice status failed cannot be marked paid=true',
      'CONTRADICTORY_PAYMENT_STATE'
    );
  }

  // 7. Transaction hints
  let txReference: string | undefined;
  let txStatus: string | undefined;
  let txAmount: number | undefined;
  let txPaidAt: Date | undefined;

  if (isRecord(data.transaction)) {
    if (typeof data.transaction.reference === 'string' && data.transaction.reference.trim()) {
      txReference = data.transaction.reference.trim();
    }
    if (typeof data.transaction.status === 'string' && data.transaction.status.trim()) {
      txStatus = data.transaction.status.trim().toLowerCase();
    }
    if (typeof data.transaction.amount === 'number' && Number.isSafeInteger(data.transaction.amount)) {
      txAmount = data.transaction.amount;
    }
    txPaidAt = parseDateValue(data.transaction.paid_at, 'transaction.paid_at');
  }

  let topReference: string | undefined;
  if (typeof data.reference === 'string' && data.reference.trim()) {
    topReference = data.reference.trim();
  }

  if (txReference && topReference && txReference !== topReference) {
    throw new MalformedRenewalHintError(
      `Contradictory transaction reference: top-level (${topReference}) does not match nested (${txReference})`,
      'CONTRADICTORY_REFERENCE'
    );
  }

  const effectiveReference = txReference ?? topReference;
  if (effectiveReference !== undefined && !PAYSTACK_TRANSACTION_REF_PATTERN.test(effectiveReference)) {
    throw new MalformedRenewalHintError(
      `Invalid transaction reference format: ${effectiveReference}`,
      'INVALID_REFERENCE'
    );
  }

  if (amountCents !== undefined && txAmount !== undefined && amountCents !== txAmount) {
    throw new MalformedRenewalHintError(
      `Contradictory amount: invoice amount (${amountCents}) does not match transaction amount (${txAmount})`,
      'CONTRADICTORY_AMOUNT'
    );
  }

  // 8. Period bounds
  const periodStart = parseDateValue(data.period_start, 'period_start');
  const periodEnd = parseDateValue(data.period_end, 'period_end');

  if (periodStart && periodEnd && periodEnd.getTime() <= periodStart.getTime()) {
    throw new MalformedRenewalHintError(
      `Contradictory period range: period_end (${periodEnd.toISOString()}) must be after period_start (${periodStart.toISOString()})`,
      'CONTRADICTORY_PERIOD'
    );
  }

  // Construct non-sensitive hint objects without fabricating absent fields
  const subscription: UntrustedRenewalSubscriptionHint | undefined = subscriptionCode
    ? {
        subscriptionCode,
        ...(subStatus ? { status: subStatus } : {}),
      }
    : undefined;

  const customer: UntrustedRenewalCustomerHint | undefined = customerCode
    ? {
        customerCode,
        ...(customerEmail ? { email: customerEmail } : {}),
      }
    : undefined;

  const plan: UntrustedRenewalPlanHint | undefined = planCode
    ? {
        planCode,
        ...(planAmount !== undefined ? { amountCents: planAmount } : {}),
        ...(effectiveCurrency ? { currency: effectiveCurrency as PaystackCurrency } : {}),
        ...(planInterval ? { interval: planInterval } : {}),
      }
    : undefined;

  const invoice: UntrustedRenewalInvoiceHint | undefined =
    invoiceCode || invoiceId || invoiceStatus || paid !== undefined || paidAt
      ? {
          ...(invoiceCode ? { invoiceCode } : {}),
          ...(invoiceId ? { invoiceId } : {}),
          ...(invoiceStatus ? { status: invoiceStatus } : {}),
          ...(paid !== undefined ? { paid } : {}),
          ...(paidAt ? { paidAt } : {}),
        }
      : undefined;

  const transaction: UntrustedRenewalTransactionHint | undefined =
    effectiveReference || txStatus || txAmount !== undefined || txPaidAt
      ? {
          reference: effectiveReference ?? 'UNSPECIFIED_REFERENCE',
          ...(txStatus ? { status: txStatus } : {}),
          ...(txAmount !== undefined ? { amountCents: txAmount } : {}),
          ...(txPaidAt ? { paidAt: txPaidAt } : {}),
        }
      : undefined;

  const period: UntrustedRenewalPeriodHint | undefined =
    periodStart || periodEnd
      ? {
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {}),
        }
      : undefined;

  const baseHint = {
    eventType,
    provider: 'paystack' as const,
    ...(subscription ? { subscription } : {}),
    ...(customer ? { customer } : {}),
    ...(plan ? { plan } : {}),
    ...(invoice ? { invoice } : {}),
    ...(transaction && transaction.reference !== 'UNSPECIFIED_REFERENCE' ? { transaction } : {}),
    ...(period ? { period } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(effectiveCurrency ? { currency: effectiveCurrency as PaystackCurrency } : {}),
  };

  const cycleCandidate = computeRenewalCycleCandidate(baseHint);

  return {
    ...baseHint,
    cycleCandidate,
  };
};
