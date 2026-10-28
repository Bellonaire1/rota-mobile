import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { MockPaystackGateway, PaymentGatewayError, type ProviderPlan } from '../billing/payments';
import { prisma } from '../database/prisma';
import {
  ProviderPlanRecoveryRequiredError,
  ProviderPlanReservationConflictError,
  ProviderPlanReservationError,
  ProviderPlanReservationService,
} from './provider-plan-reservation.service';
import { reconciliationIntegrationSkipReason } from './reconciliation-test-safety';

describe('ProviderPlanReservationService', { concurrency: false, skip: reconciliationIntegrationSkipReason() }, () => {
  after(async () => {
    await prisma.$disconnect();
  });

  const createTeam = async (): Promise<{ teamId: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: `plan-res-${randomUUID()}@example.com`,
        name: 'Plan Reservation Test',
        passwordHash: 'test-hash',
      },
    });
    const team = await prisma.team.create({
      data: {
        name: `Plan Reservation Team ${randomUUID()}`,
        createdByUserId: user.id,
      },
    });
    return { teamId: team.id, userId: user.id };
  };

  it('creates a new provider-plan reservation and completes with validated provider plan code', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    const result = await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);

    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.teamId, teamId);
    assert.equal(result.planCode, 'TEAM');
    assert.equal(result.billableStaffSeats, 10);
    assert.equal(result.amountCents, 5_000);
    assert.equal(result.currency, 'USD');
    assert.equal(result.interval, 'monthly');
    assert.match(result.providerPlanCode ?? '', /^PLN_mock_5000_\d+$/);
    assert.match(result.providerPlanId ?? '', /^\d+$/);
  });

  it('is idempotent on replay with identical parameters', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    const first = await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);

    // Replay with identical parameters
    const second = await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);

    assert.deepEqual(second, first);
  });

  it('rejects the same idempotency key when called with different parameters', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);

    // Call with different plan code
    await assert.rejects(
      service.getOrCreatePlan({
        teamId,
        planCode: 'STARTER',
        billableStaffSeats: 5,
        idempotencyKey,
      }, gateway),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );

    // Call with different seat count
    await assert.rejects(
      service.getOrCreatePlan({
        teamId,
        planCode: 'TEAM',
        billableStaffSeats: 20,
        idempotencyKey,
      }, gateway),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );
  });

  it('records uncertain provider outcome on timeout and blocks automatic plan re-creation', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));

    await assert.rejects(
      service.getOrCreatePlan({
        teamId,
        planCode: 'TEAM',
        billableStaffSeats: 10,
        idempotencyKey,
      }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Calling again with the same key must NOT call gateway.createPlan again; it must fail closed
    await assert.rejects(
      service.getOrCreatePlan({
        teamId,
        planCode: 'TEAM',
        billableStaffSeats: 10,
        idempotencyKey,
      }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('reconciles uncertain reservation when verified provider plan is provided', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));

    await assert.rejects(
      service.getOrCreatePlan({
        teamId,
        planCode: 'TEAM',
        billableStaffSeats: 10,
        idempotencyKey,
      }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    const verifiedPlan: ProviderPlan = {
      providerPlanId: '98765',
      planCode: 'PLN_reconciled_123',
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    };

    const reconciled = await service.resolveReconciliation({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, verifiedPlan);

    assert.equal(reconciled.state, 'COMPLETED');
    assert.equal(reconciled.providerPlanCode, 'PLN_reconciled_123');
    assert.equal(reconciled.providerPlanId, '98765');

    // Subsequent calls now return the completed reservation
    const replay = await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);
    assert.equal(replay.state, 'COMPLETED');
    assert.equal(replay.providerPlanCode, 'PLN_reconciled_123');
  });

  it('protects concurrent reservations and converges to one creator', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const idempotencyKey = `plan-key-${randomUUID()}`;

    const [first, second] = await Promise.all([
      service.reserve({
        teamId,
        planCode: 'BUSINESS',
        billableStaffSeats: 40,
        idempotencyKey,
      }),
      service.reserve({
        teamId,
        planCode: 'BUSINESS',
        billableStaffSeats: 40,
        idempotencyKey,
      }),
    ]);

    // Exactly one should be existing: false (the creator), and the other existing: true (the replay)
    assert.equal([first.existing, second.existing].filter(Boolean).length, 1);
    assert.equal([first.existing, second.existing].filter((v) => !v).length, 1);
    assert.equal(first.reservation.amountCents, 12_000);
    assert.equal(second.reservation.amountCents, 12_000);
  });

  it('scopes plan reservations per team', async () => {
    const team1 = await createTeam();
    const team2 = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const sharedKey = `shared-idempotency-key-${randomUUID()}`;

    const plan1 = await service.getOrCreatePlan({
      teamId: team1.teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey: sharedKey,
    }, gateway);

    const plan2 = await service.getOrCreatePlan({
      teamId: team2.teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey: sharedKey,
    }, gateway);

    assert.equal(plan1.teamId, team1.teamId);
    assert.equal(plan2.teamId, team2.teamId);
    assert.notEqual(plan1.planName, plan2.planName);
    assert.notEqual(plan1.providerPlanId, plan2.providerPlanId);
  });
});
