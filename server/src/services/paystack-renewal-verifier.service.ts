import {
  BillingSubscriptionStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  PAYSTACK_PLAN_CODE_PATTERN,
  PAYSTACK_USD_MINIMUM_CENTS,
  PaymentGatewayError,
  type PaymentGateway,
  type VerifiedPayment,
  type VerifiedSubscription,
} from '../billing/payments';
import type { UntrustedRenewalEventHint } from './paystack-renewal.service';

export type RenewalVerificationDatabase = PrismaClient | Prisma.TransactionClient;

export type RenewalVerificationOutcome =
  | 'VERIFIED_PENDING_CYCLE_PROOF'
  | 'INSUFFICIENT_CYCLE_PROOF'
  | 'PROVIDER_OUTAGE'
  | 'DEFINITIVE_CONTRADICTION'
  | 'CONFLICT';

export interface VerifiedRenewalSubscriptionProof {
  readonly providerSubscriptionId: string;
  readonly subscriptionCode: string;
  readonly providerCustomerId: string;
  readonly planCode: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly interval: 'monthly';
  readonly status: 'active';
  readonly localSubscriptionId: string;
  readonly teamId: string;
}

export interface VerifiedRenewalTransactionProof {
  readonly reference: string;
  readonly providerTransactionId: string;
  readonly providerCustomerId: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly status: 'success';
}

export interface VerifiedRenewalCycleProof {
  readonly cycleProofStatus: 'INSUFFICIENT_CYCLE_PROOF';
  readonly candidateKey: string | null;
  readonly hasIndependentProviderProof: false;
  readonly reasons: readonly string[];
}

export interface RenewalVerificationResult {
  readonly outcome: RenewalVerificationOutcome;
  readonly isReadyForSettlement: false;
  readonly subscriptionProof?: VerifiedRenewalSubscriptionProof;
  readonly transactionProof?: VerifiedRenewalTransactionProof;
  readonly cycleProof: VerifiedRenewalCycleProof;
  readonly isReplayCandidate?: boolean;
  readonly error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isProviderOutageError = (error: unknown): boolean => {
  if (error instanceof PaymentGatewayError) {
    return ['TIMEOUT', 'NETWORK', 'PROVIDER_FAILURE', 'HTTP'].includes(error.code);
  }
  return false;
};

interface LocalSubscriptionForPlanResolution {
  readonly currentPlan?: { readonly code?: string } | null;
  readonly periods?: ReadonlyArray<{ readonly planCodeSnapshot?: string | null }> | null;
  readonly invoices?: ReadonlyArray<{
    readonly paymentAttempts?: ReadonlyArray<{
      readonly idempotencyRecord?: {
        readonly responseBody?: unknown;
      } | null;
    }> | null;
  }> | null;
}

interface LocalSubscriptionForAmountResolution {
  readonly currentPrice?: { readonly monthlyPriceCents?: number | null } | null;
  readonly periods?: ReadonlyArray<{ readonly totalAmountCents?: number | null }> | null;
  readonly invoices?: ReadonlyArray<{
    readonly paymentAttempts?: ReadonlyArray<{
      readonly idempotencyRecord?: {
        readonly responseBody?: unknown;
      } | null;
    }> | null;
  }> | null;
}

export const resolveExpectedProviderPlanCode = (
  localSubscription: LocalSubscriptionForPlanResolution
): string | null => {
  const checkoutPlanCodes = new Set<string>();

  if (Array.isArray(localSubscription.invoices)) {
    for (const invoice of localSubscription.invoices) {
      if (!Array.isArray(invoice.paymentAttempts)) continue;
      for (const attempt of invoice.paymentAttempts) {
        let body = attempt.idempotencyRecord?.responseBody;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            body = null;
          }
        }
        if (isRecord(body) && body.recurring === true) {
          if (typeof body.providerPlanCode === 'string' && PAYSTACK_PLAN_CODE_PATTERN.test(body.providerPlanCode)) {
            checkoutPlanCodes.add(body.providerPlanCode);
          } else {
            return null;
          }
        }
      }
    }
  }

  if (checkoutPlanCodes.size > 1) {
    return null;
  }

  const periodCode = localSubscription.periods?.[0]?.planCodeSnapshot;
  const isPeriodProviderCode = typeof periodCode === 'string' && PAYSTACK_PLAN_CODE_PATTERN.test(periodCode);

  const currentPlanCode = localSubscription.currentPlan?.code;
  const isCurrentPlanProviderCode = typeof currentPlanCode === 'string' && PAYSTACK_PLAN_CODE_PATTERN.test(currentPlanCode);

  if (checkoutPlanCodes.size === 1) {
    const [checkoutCode] = checkoutPlanCodes;
    if (isPeriodProviderCode && periodCode !== checkoutCode) {
      return null;
    }
    if (isCurrentPlanProviderCode && currentPlanCode !== checkoutCode) {
      return null;
    }
    return checkoutCode;
  }

  if (isPeriodProviderCode && isCurrentPlanProviderCode) {
    if (periodCode !== currentPlanCode) {
      return null;
    }
    return periodCode;
  }

  if (isPeriodProviderCode) {
    return periodCode;
  }

  if (isCurrentPlanProviderCode) {
    return currentPlanCode;
  }

  return null;
};

export const resolveExpectedRenewalAmountCents = (
  localSubscription: LocalSubscriptionForAmountResolution
): number | null => {
  const checkoutAmounts = new Set<number>();

  if (Array.isArray(localSubscription.invoices)) {
    for (const invoice of localSubscription.invoices) {
      if (!Array.isArray(invoice.paymentAttempts)) continue;
      for (const attempt of invoice.paymentAttempts) {
        let body = attempt.idempotencyRecord?.responseBody;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            body = null;
          }
        }
        if (isRecord(body) && body.recurring === true) {
          if (
            typeof body.amountCents === 'number' &&
            Number.isSafeInteger(body.amountCents) &&
            body.amountCents >= PAYSTACK_USD_MINIMUM_CENTS
          ) {
            checkoutAmounts.add(body.amountCents);
          } else {
            return null;
          }
        }
      }
    }
  }

  if (checkoutAmounts.size > 1) {
    return null;
  }

  const periodAmount = localSubscription.periods?.[0]?.totalAmountCents;
  const isPeriodAmountValid =
    typeof periodAmount === 'number' &&
    Number.isSafeInteger(periodAmount) &&
    periodAmount >= PAYSTACK_USD_MINIMUM_CENTS;

  if (checkoutAmounts.size === 1) {
    const [checkoutAmount] = checkoutAmounts;
    if (isPeriodAmountValid && periodAmount !== checkoutAmount) {
      return null;
    }
    return checkoutAmount;
  }

  if (isPeriodAmountValid) {
    return periodAmount;
  }

  const priceAmount = localSubscription.currentPrice?.monthlyPriceCents;
  if (
    typeof priceAmount === 'number' &&
    Number.isSafeInteger(priceAmount) &&
    priceAmount >= PAYSTACK_USD_MINIMUM_CENTS
  ) {
    return priceAmount;
  }

  return null;
};

export class PaystackRenewalVerifier {
  constructor(
    private readonly database: RenewalVerificationDatabase,
    private readonly gateway: PaymentGateway
  ) {}

  async verifyRenewal(hint: UntrustedRenewalEventHint): Promise<RenewalVerificationResult> {
    const defaultCycleProof: VerifiedRenewalCycleProof = {
      cycleProofStatus: 'INSUFFICIENT_CYCLE_PROOF',
      candidateKey: hint.cycleCandidate.candidateKey,
      hasIndependentProviderProof: false,
      reasons: [
        'INSUFFICIENT_CYCLE_PROOF: Documented Paystack read-only APIs do not establish an immutable association between transaction reference and distinct invoice/cycle.',
        ...hint.cycleCandidate.candidateLimitations,
      ],
    };

    // 1. Subscription Hint Validation
    if (!hint.subscription?.subscriptionCode) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: 'Untrusted renewal hint lacks a provider subscription code',
      };
    }

    const subCode = hint.subscription.subscriptionCode;

    // 2. Load uniquely matching local subscription via stored providerSubscriptionId
    const localSubscription = await this.database.billingSubscription.findUnique({
      where: { providerSubscriptionId: subCode },
      include: {
        currentPlan: true,
        currentPrice: true,
        periods: {
          orderBy: { sequence: 'desc' },
          take: 1,
        },
        invoices: {
          include: {
            paymentAttempts: {
              include: {
                idempotencyRecord: true,
              },
            },
          },
        },
      },
    });

    if (!localSubscription) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `No local subscription matches providerSubscriptionId ${subCode}`,
      };
    }

    if (localSubscription.status !== BillingSubscriptionStatus.ACTIVE) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Local subscription status is ${localSubscription.status}; renewals require ACTIVE status`,
      };
    }

    if (!localSubscription.providerCustomerId) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: 'Local subscription lacks a stored providerCustomerId',
      };
    }

    if (localSubscription.currency !== 'USD') {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Local subscription currency is ${localSubscription.currency}; expected USD`,
      };
    }

    const expectedCustomerCode = localSubscription.providerCustomerId;
    const expectedPlanCode = resolveExpectedProviderPlanCode(localSubscription);
    if (!expectedPlanCode) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: 'Cannot unambiguously determine expected provider plan code from local subscription or checkout evidence',
      };
    }

    const expectedAmountCents = resolveExpectedRenewalAmountCents(localSubscription);
    if (expectedAmountCents === null) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: 'Cannot unambiguously determine expected historical renewal amount from local subscription or period evidence',
      };
    }

    // 3. Webhook pre-gateway identity consistency checks
    if (hint.customer?.customerCode && hint.customer.customerCode !== expectedCustomerCode) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Webhook customer code (${hint.customer.customerCode}) does not match local subscription customer code (${expectedCustomerCode})`,
      };
    }

    if (hint.amountCents !== undefined && hint.amountCents !== expectedAmountCents) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Webhook amount (${hint.amountCents}) does not match expected renewal amount (${expectedAmountCents})`,
      };
    }

    if (hint.plan?.amountCents !== undefined && hint.plan.amountCents !== expectedAmountCents) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Webhook plan amount (${hint.plan.amountCents}) does not match expected renewal amount (${expectedAmountCents})`,
      };
    }

    if (hint.transaction?.amountCents !== undefined && hint.transaction.amountCents !== expectedAmountCents) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Webhook transaction amount (${hint.transaction.amountCents}) does not match expected renewal amount (${expectedAmountCents})`,
      };
    }

    if (hint.plan?.planCode && hint.plan.planCode !== expectedPlanCode) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Webhook plan code (${hint.plan.planCode}) does not match expected provider plan code (${expectedPlanCode})`,
      };
    }

    // 4. Independently verify provider subscription identity via gateway
    let verifiedSub: VerifiedSubscription | null;
    try {
      verifiedSub = await this.gateway.fetchSubscriptionByCode({
        subscriptionCode: subCode,
        expectedPlanCode,
        expectedCustomerCode,
        expectedAmountCents,
        expectedCurrency: 'USD',
        expectedInterval: 'monthly',
      });
    } catch (error) {
      if (isProviderOutageError(error)) {
        return {
          outcome: 'PROVIDER_OUTAGE',
          isReadyForSettlement: false,
          cycleProof: defaultCycleProof,
          error: `Provider subscription lookup outage: ${(error as Error).message}`,
        };
      }
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Provider subscription verification failed: ${(error as Error).message}`,
      };
    }

    if (!verifiedSub) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: `Provider subscription ${subCode} was not found on Paystack`,
      };
    }

    if (
      verifiedSub.status !== 'active' ||
      verifiedSub.subscriptionCode !== subCode ||
      verifiedSub.customerCode !== expectedCustomerCode ||
      verifiedSub.planCode !== expectedPlanCode ||
      verifiedSub.amountCents !== expectedAmountCents ||
      verifiedSub.currency !== 'USD' ||
      verifiedSub.interval !== 'monthly'
    ) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        cycleProof: defaultCycleProof,
        error: 'Verified provider subscription attributes do not match expected local subscription identities',
      };
    }

    const subscriptionProof: VerifiedRenewalSubscriptionProof = {
      providerSubscriptionId: verifiedSub.providerSubscriptionId,
      subscriptionCode: verifiedSub.subscriptionCode,
      providerCustomerId: verifiedSub.customerCode,
      planCode: verifiedSub.planCode,
      amountCents: verifiedSub.amountCents,
      currency: 'USD',
      interval: 'monthly',
      status: 'active',
      localSubscriptionId: localSubscription.id,
      teamId: localSubscription.teamId,
    };

    // 5. Check Provider Invoice Conflicts (if invoice code is supplied in hint)
    if (hint.invoice?.invoiceCode) {
      const existingInvoice = await this.database.billingInvoice.findUnique({
        where: { providerInvoiceId: hint.invoice.invoiceCode },
      });
      if (existingInvoice && existingInvoice.subscriptionId !== localSubscription.id) {
        return {
          outcome: 'CONFLICT',
          isReadyForSettlement: false,
          subscriptionProof,
          cycleProof: defaultCycleProof,
          error: `Provider invoice code ${hint.invoice.invoiceCode} is already bound to another subscription (${existingInvoice.subscriptionId})`,
        };
      }
    }

    // 6. Independently verify candidate transaction (if present)
    let transactionProof: VerifiedRenewalTransactionProof | undefined;
    let isReplayCandidate = false;

    if (hint.transaction?.reference) {
      let verifiedTx: VerifiedPayment;
      try {
        // Do NOT pass expectedMetadata for renewals (renewals are provider-created)
        verifiedTx = await this.gateway.verifyTransaction({
          reference: hint.transaction.reference,
          expectedAmountCents,
          expectedCurrency: 'USD',
        });
      } catch (error) {
        if (isProviderOutageError(error)) {
          return {
            outcome: 'PROVIDER_OUTAGE',
            isReadyForSettlement: false,
            subscriptionProof,
            cycleProof: defaultCycleProof,
            error: `Provider transaction verification outage: ${(error as Error).message}`,
          };
        }
        return {
          outcome: 'DEFINITIVE_CONTRADICTION',
          isReadyForSettlement: false,
          subscriptionProof,
          cycleProof: defaultCycleProof,
          error: `Provider transaction verification failed: ${(error as Error).message}`,
        };
      }

      if (
        verifiedTx.status !== 'success' ||
        verifiedTx.reference !== hint.transaction.reference ||
        !verifiedTx.providerTransactionId ||
        verifiedTx.amountCents !== expectedAmountCents ||
        verifiedTx.currency !== 'USD'
      ) {
        return {
          outcome: 'DEFINITIVE_CONTRADICTION',
          isReadyForSettlement: false,
          subscriptionProof,
          cycleProof: defaultCycleProof,
          error: 'Verified transaction attributes do not match expected renewal parameters',
        };
      }

      if (!verifiedTx.providerCustomerId || verifiedTx.providerCustomerId !== expectedCustomerCode) {
        return {
          outcome: 'DEFINITIVE_CONTRADICTION',
          isReadyForSettlement: false,
          subscriptionProof,
          cycleProof: defaultCycleProof,
          error: !verifiedTx.providerCustomerId
            ? 'Verified transaction lacks a provider customer ID'
            : `Verified transaction customer code (${verifiedTx.providerCustomerId}) does not match subscription customer code (${expectedCustomerCode})`,
        };
      }

      // 7. Check transaction identity reuse across payment attempts
      const existingAttempt = await this.database.billingPaymentAttempt.findUnique({
        where: { providerPaymentId: verifiedTx.providerTransactionId },
        include: { invoice: true },
      });

      if (existingAttempt) {
        if (existingAttempt.invoice.subscriptionId !== localSubscription.id) {
          return {
            outcome: 'CONFLICT',
            isReadyForSettlement: false,
            subscriptionProof,
            cycleProof: defaultCycleProof,
            error: `Provider transaction ID ${verifiedTx.providerTransactionId} is already linked to another subscription (${existingAttempt.invoice.subscriptionId})`,
          };
        }
        isReplayCandidate = true;
      }

      transactionProof = {
        reference: verifiedTx.reference,
        providerTransactionId: verifiedTx.providerTransactionId,
        providerCustomerId: verifiedTx.providerCustomerId,
        amountCents: verifiedTx.amountCents,
        currency: 'USD',
        status: 'success',
      };
    }

    // 8. Cycle Association Proof Assessment
    // Under official Paystack read-only APIs, neither GET /transaction/verify nor GET /subscription
    // provides an immutable proof binding the transaction to a distinct invoice or period cycle.
    // The cycle proof MUST remain unresolved/insufficient.
    return {
      outcome: transactionProof ? 'VERIFIED_PENDING_CYCLE_PROOF' : 'INSUFFICIENT_CYCLE_PROOF',
      isReadyForSettlement: false,
      subscriptionProof,
      ...(transactionProof ? { transactionProof } : {}),
      cycleProof: defaultCycleProof,
      ...(isReplayCandidate ? { isReplayCandidate: true } : {}),
    };
  }
}
