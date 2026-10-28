import { createHash } from 'node:crypto';
import { BillingIdempotencyStatus, Prisma, PrismaClient } from '@prisma/client';
import {
  PaymentGatewayError,
  type PaymentGateway,
  type ProviderPlan,
} from '../billing/payments';
import {
  calculateSeatPricing,
  type BillingPlanCode as PricingPlanCode,
} from '../billing/pricing';
import { prisma as defaultPrisma } from '../database/prisma';

export const PROVIDER_PLAN_SCOPE_PREFIX = 'team-provider-plan';

export type ProviderPlanReservationState =
  | 'RESERVED'
  | 'RECOVERY_REQUIRED'
  | 'COMPLETED'
  | 'FAILED';

export interface ProviderPlanReservationInput {
  readonly teamId: string;
  readonly subscriptionId?: string;
  readonly planCode: 'STARTER' | 'TEAM' | 'BUSINESS';
  readonly billableStaffSeats: number;
  readonly idempotencyKey: string;
}

export interface PersistedProviderPlanReservation {
  readonly state: ProviderPlanReservationState;
  readonly teamId: string;
  readonly subscriptionId?: string;
  readonly planCode: 'STARTER' | 'TEAM' | 'BUSINESS';
  readonly billableStaffSeats: number;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly interval: 'monthly';
  readonly planName: string;
  readonly providerPlanId?: string;
  readonly providerPlanCode?: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProviderPlanReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPlanReservationError';
  }
}

export class ProviderPlanReservationConflictError extends ProviderPlanReservationError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPlanReservationConflictError';
  }
}

export class ProviderPlanRecoveryRequiredError extends ProviderPlanReservationError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPlanRecoveryRequiredError';
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;
const MAX_RESERVATION_ATTEMPTS = 5;

const assertIdempotencyKey = (key: string): void => {
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ProviderPlanReservationError('A valid idempotency key is required');
  }
};

const canonicalRequest = (input: {
  teamId: string;
  subscriptionId?: string;
  planCode: string;
  billableStaffSeats: number;
  amountCents: number;
}): string => JSON.stringify({
  amountCents: input.amountCents,
  billableStaffSeats: input.billableStaffSeats,
  currency: 'USD',
  interval: 'monthly',
  planCode: input.planCode,
  subscriptionId: input.subscriptionId ?? null,
  teamId: input.teamId,
  version: 1,
});

const hashRequest = (canonical: string): string =>
  createHash('sha256').update(canonical).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseReservation = (value: Prisma.JsonValue | null): PersistedProviderPlanReservation => {
  if (!isRecord(value)) {
    throw new ProviderPlanReservationError('Persisted provider-plan reservation payload is malformed');
  }
  const state = value.state;
  if (state !== 'RESERVED' && state !== 'RECOVERY_REQUIRED' && state !== 'COMPLETED' && state !== 'FAILED') {
    throw new ProviderPlanReservationError('Persisted provider-plan reservation has invalid state');
  }
  if (typeof value.teamId !== 'string'
    || typeof value.planCode !== 'string'
    || !Number.isSafeInteger(value.billableStaffSeats)
    || !Number.isSafeInteger(value.amountCents)
    || value.currency !== 'USD'
    || value.interval !== 'monthly'
    || typeof value.planName !== 'string') {
    throw new ProviderPlanReservationError('Persisted provider-plan reservation is missing required fields');
  }
  return {
    state,
    teamId: value.teamId,
    ...(typeof value.subscriptionId === 'string' ? { subscriptionId: value.subscriptionId } : {}),
    planCode: value.planCode as 'STARTER' | 'TEAM' | 'BUSINESS',
    billableStaffSeats: value.billableStaffSeats as number,
    amountCents: value.amountCents as number,
    currency: 'USD',
    interval: 'monthly',
    planName: value.planName,
    ...(typeof value.providerPlanId === 'string' ? { providerPlanId: value.providerPlanId } : {}),
    ...(typeof value.providerPlanCode === 'string' ? { providerPlanCode: value.providerPlanCode } : {}),
    ...(typeof value.failureCode === 'string' ? { failureCode: value.failureCode } : {}),
    ...(typeof value.failureMessage === 'string' ? { failureMessage: value.failureMessage } : {}),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
};

export class ProviderPlanReservationService {
  constructor(private readonly database: PrismaClient = defaultPrisma) {}

  async reserve(input: ProviderPlanReservationInput): Promise<{
    reservation: PersistedProviderPlanReservation;
    existing: boolean;
  }> {
    assertIdempotencyKey(input.idempotencyKey);
    const pricing = calculateSeatPricing(input.planCode as PricingPlanCode, input.billableStaffSeats);
    const amountCents = pricing.monthlyTotalCents;
    const scope = `${PROVIDER_PLAN_SCOPE_PREFIX}:${input.teamId}`;
    const canonical = canonicalRequest({
      teamId: input.teamId,
      subscriptionId: input.subscriptionId,
      planCode: input.planCode,
      billableStaffSeats: input.billableStaffSeats,
      amountCents,
    });
    const requestHash = hashRequest(canonical);
    const planName = `Rota ${input.planCode} (${input.billableStaffSeats} seats) - team:${input.teamId}`;

    for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt++) {
      try {
        return await this.database.$transaction(async (tx) => {
          const existing = await tx.billingIdempotencyKey.findUnique({
            where: { scope_key: { scope, key: input.idempotencyKey } },
          });

          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ProviderPlanReservationConflictError(
                'Idempotency key was used with different provider-plan creation parameters'
              );
            }
            return {
              reservation: parseReservation(existing.responseBody),
              existing: true,
            };
          }

          const now = new Date().toISOString();
          const initialReservation: PersistedProviderPlanReservation = {
            state: 'RESERVED',
            teamId: input.teamId,
            ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
            planCode: input.planCode,
            billableStaffSeats: input.billableStaffSeats,
            amountCents,
            currency: 'USD',
            interval: 'monthly',
            planName,
            createdAt: now,
            updatedAt: now,
          };

          await tx.billingIdempotencyKey.create({
            data: {
              scope,
              key: input.idempotencyKey,
              requestHash,
              status: BillingIdempotencyStatus.IN_PROGRESS,
              teamId: input.teamId,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              responseBody: initialReservation as unknown as Prisma.InputJsonValue,
            },
          });

          return {
            reservation: initialReservation,
            existing: false,
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034') &&
          attempt < MAX_RESERVATION_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ProviderPlanReservationError('Exhausted retry attempts acquiring provider-plan reservation');
  }

  async getOrCreatePlan(
    input: ProviderPlanReservationInput,
    gateway: PaymentGateway
  ): Promise<PersistedProviderPlanReservation> {
    const { reservation, existing } = await this.reserve(input);

    if (existing) {
      if (reservation.state === 'COMPLETED') {
        return reservation;
      }
      if (reservation.state === 'RECOVERY_REQUIRED') {
        throw new ProviderPlanRecoveryRequiredError(
          'Provider plan outcome is uncertain; reconciliation required before retrying'
        );
      }
      if (reservation.state === 'FAILED') {
        throw new ProviderPlanReservationError(
          `Provider plan creation previously failed: ${reservation.failureMessage ?? 'unknown'}`
        );
      }
      return reservation;
    }

    const scope = `${PROVIDER_PLAN_SCOPE_PREFIX}:${input.teamId}`;

    let plan: ProviderPlan;
    try {
      plan = await gateway.createPlan({
        name: reservation.planName,
        amountCents: reservation.amountCents,
        interval: reservation.interval,
        currency: reservation.currency,
      });
    } catch (error) {
      const now = new Date().toISOString();
      if (error instanceof PaymentGatewayError && error.code === 'TIMEOUT') {
        const timeoutReservation: PersistedProviderPlanReservation = {
          ...reservation,
          state: 'RECOVERY_REQUIRED',
          failureCode: 'TIMEOUT',
          failureMessage: error.message,
          updatedAt: now,
        };
        await this.database.billingIdempotencyKey.update({
          where: { scope_key: { scope, key: input.idempotencyKey } },
          data: {
            responseBody: timeoutReservation as unknown as Prisma.InputJsonValue,
          },
        });
        throw new ProviderPlanRecoveryRequiredError(
          'Provider plan creation timed out and requires reconciliation'
        );
      }

      const failureCode = error instanceof PaymentGatewayError ? error.code : 'UNKNOWN';
      const failureMessage = error instanceof Error ? error.message : 'Unknown error';
      const failedReservation: PersistedProviderPlanReservation = {
        ...reservation,
        state: 'FAILED',
        failureCode,
        failureMessage,
        updatedAt: now,
      };
      await this.database.billingIdempotencyKey.update({
        where: { scope_key: { scope, key: input.idempotencyKey } },
        data: {
          status: BillingIdempotencyStatus.FAILED,
          completedAt: new Date(),
          responseBody: failedReservation as unknown as Prisma.InputJsonValue,
        },
      });
      throw error;
    }

    const now = new Date().toISOString();
    const completedReservation: PersistedProviderPlanReservation = {
      ...reservation,
      state: 'COMPLETED',
      providerPlanId: plan.providerPlanId,
      providerPlanCode: plan.planCode,
      updatedAt: now,
    };

    await this.database.billingIdempotencyKey.update({
      where: { scope_key: { scope, key: input.idempotencyKey } },
      data: {
        status: BillingIdempotencyStatus.SUCCEEDED,
        completedAt: new Date(),
        responseBody: completedReservation as unknown as Prisma.InputJsonValue,
      },
    });

    return completedReservation;
  }

  async resolveReconciliation(
    input: ProviderPlanReservationInput & { candidatePlanCode?: string },
    candidatePlanCodeOrGateway: string | PaymentGateway,
    maybeGateway?: PaymentGateway
  ): Promise<PersistedProviderPlanReservation | null> {
    assertIdempotencyKey(input.idempotencyKey);
    const candidatePlanCode = typeof candidatePlanCodeOrGateway === 'string'
      ? candidatePlanCodeOrGateway
      : input.candidatePlanCode;
    const gateway = typeof candidatePlanCodeOrGateway === 'string'
      ? maybeGateway
      : candidatePlanCodeOrGateway;

    if (!gateway) {
      throw new ProviderPlanReservationError('Payment gateway is required for reconciliation');
    }
    if (!candidatePlanCode || typeof candidatePlanCode !== 'string') {
      throw new ProviderPlanReservationError('Candidate provider plan code is required');
    }

    const pricing = calculateSeatPricing(input.planCode as PricingPlanCode, input.billableStaffSeats);
    const amountCents = pricing.monthlyTotalCents;
    const scope = `${PROVIDER_PLAN_SCOPE_PREFIX}:${input.teamId}`;
    const canonical = canonicalRequest({
      teamId: input.teamId,
      subscriptionId: input.subscriptionId,
      planCode: input.planCode,
      billableStaffSeats: input.billableStaffSeats,
      amountCents,
    });
    const requestHash = hashRequest(canonical);
    const planName = `Rota ${input.planCode} (${input.billableStaffSeats} seats) - team:${input.teamId}`;

    const existing = await this.database.billingIdempotencyKey.findUnique({
      where: { scope_key: { scope, key: input.idempotencyKey } },
    });
    if (!existing) {
      throw new ProviderPlanReservationError('No provider-plan reservation found to reconcile');
    }
    if (existing.teamId !== input.teamId) {
      throw new ProviderPlanReservationConflictError('Provider-plan reservation belongs to a different team');
    }
    if (existing.requestHash !== requestHash) {
      throw new ProviderPlanReservationConflictError(
        'Idempotency key was used with different provider-plan creation parameters'
      );
    }

    const current = parseReservation(existing.responseBody);
    if (
      current.teamId !== input.teamId ||
      current.planCode !== input.planCode ||
      current.billableStaffSeats !== input.billableStaffSeats ||
      current.amountCents !== amountCents ||
      current.currency !== 'USD' ||
      current.interval !== 'monthly' ||
      current.planName !== planName
    ) {
      throw new ProviderPlanReservationConflictError(
        'Supplied parameters do not match the persisted reservation'
      );
    }

    if (current.state === 'COMPLETED') {
      if (current.providerPlanCode === candidatePlanCode) {
        return current;
      }
      throw new ProviderPlanReservationConflictError(
        'Provider plan reservation was already completed with a different plan code'
      );
    }
    if (current.state === 'FAILED') {
      throw new ProviderPlanReservationError(
        `Cannot reconcile a failed reservation: ${current.failureMessage ?? 'unknown failure'}`
      );
    }
    if (current.state !== 'RECOVERY_REQUIRED') {
      throw new ProviderPlanReservationError(
        `Cannot reconcile reservation in state ${current.state}`
      );
    }

    let verifiedPlan: ProviderPlan | null = null;
    try {
      verifiedPlan = await gateway.fetchPlanByCode({
        planCode: candidatePlanCode,
        expectedAmountCents: current.amountCents,
        expectedCurrency: current.currency,
        expectedInterval: current.interval,
        expectedName: current.planName,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError) {
        return null;
      }
      throw error;
    }

    if (!verifiedPlan) {
      return null;
    }

    for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt++) {
      try {
        return await this.database.$transaction(async (tx) => {
          const record = await tx.billingIdempotencyKey.findUnique({
            where: { scope_key: { scope, key: input.idempotencyKey } },
          });
          if (!record) {
            throw new ProviderPlanReservationError('No provider-plan reservation found to reconcile');
          }
          if (record.requestHash !== requestHash) {
            throw new ProviderPlanReservationConflictError(
              'Idempotency key was used with different provider-plan creation parameters'
            );
          }

          const latest = parseReservation(record.responseBody);
          if (latest.state === 'COMPLETED') {
            if (latest.providerPlanCode === verifiedPlan!.planCode) {
              return latest;
            }
            throw new ProviderPlanReservationConflictError(
              'Provider plan reservation was already completed with a different plan code'
            );
          }
          if (latest.state !== 'RECOVERY_REQUIRED') {
            throw new ProviderPlanReservationError(
              `Cannot reconcile reservation in state ${latest.state}`
            );
          }

          const now = new Date().toISOString();
          const { failureCode: _fc, failureMessage: _fm, ...cleanLatest } = latest;
          const completed: PersistedProviderPlanReservation = {
            ...cleanLatest,
            state: 'COMPLETED',
            providerPlanId: verifiedPlan!.providerPlanId,
            providerPlanCode: verifiedPlan!.planCode,
            updatedAt: now,
          };

          await tx.billingIdempotencyKey.update({
            where: { scope_key: { scope, key: input.idempotencyKey } },
            data: {
              status: BillingIdempotencyStatus.SUCCEEDED,
              completedAt: new Date(),
              responseBody: completed as unknown as Prisma.InputJsonValue,
            },
          });

          return completed;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034') &&
          attempt < MAX_RESERVATION_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new ProviderPlanReservationError('Exhausted retry attempts reconciling provider-plan reservation');
  }
}
