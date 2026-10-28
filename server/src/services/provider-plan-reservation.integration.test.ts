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

  it('reconciles uncertain reservation using verified Paystack lookup', async () => {
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

    const candidatePlanCode = 'PLN_reconciled_123';
    gateway.setPlanLookupResult(candidatePlanCode, {
      providerPlanId: '98765',
      planCode: candidatePlanCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    const reconciled = await service.resolveReconciliation({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, candidatePlanCode, gateway);

    assert.ok(reconciled);
    assert.equal(reconciled.state, 'COMPLETED');
    assert.equal(reconciled.providerPlanCode, candidatePlanCode);
    assert.equal(reconciled.providerPlanId, '98765');

    // Subsequent calls now return the completed reservation
    const replay = await service.getOrCreatePlan({
      teamId,
      planCode: 'TEAM',
      billableStaffSeats: 10,
      idempotencyKey,
    }, gateway);
    assert.equal(replay.state, 'COMPLETED');
    assert.equal(replay.providerPlanCode, candidatePlanCode);
  });

  it('returns recorded identity on completed replay and rejects conflicting plan code', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    const planCode = 'PLN_reconciled_replay';
    gateway.setPlanLookupResult(planCode, {
      providerPlanId: '11111',
      planCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    const first = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      planCode,
      gateway
    );
    assert.ok(first);
    assert.equal(first.state, 'COMPLETED');

    // Replay with same plan code returns identical result without re-fetching
    const second = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      planCode,
      gateway
    );
    assert.deepEqual(second, first);

    // Replay with different candidate plan code throws conflict error
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
        'PLN_conflicting_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );
  });

  it('leaves reservation unresolved when provider plan attributes mismatch', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Mismatched amount
    const mismatchCode = 'PLN_mismatch_amount';
    gateway.setPlanLookupResult(mismatchCode, {
      providerPlanId: '22222',
      planCode: mismatchCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 4_000, // Expected 5_000
      currency: 'USD',
      interval: 'monthly',
    });

    const result = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      mismatchCode,
      gateway
    );
    assert.equal(result, null);

    // Reservation still in RECOVERY_REQUIRED
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('leaves reservation unresolved when candidate plan is not found in Paystack', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Unconfigured plan returns null in MockPaystackGateway
    const result = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      'PLN_non_existent_code',
      gateway
    );
    assert.equal(result, null);

    // Reservation still in RECOVERY_REQUIRED
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('leaves reservation unresolved on provider network failure or timeout during lookup', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    const outageCode = 'PLN_outage_code';
    gateway.setPlanLookupResult(outageCode, new PaymentGatewayError('TIMEOUT', 'Lookup timeout'));

    const result = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      outageCode,
      gateway
    );
    assert.equal(result, null);

    // Also with provider failure
    gateway.setPlanLookupResult(outageCode, new PaymentGatewayError('PROVIDER_FAILURE', '500 Internal error'));
    const resultFailure = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      outageCode,
      gateway
    );
    assert.equal(resultFailure, null);

    // Reservation still in RECOVERY_REQUIRED
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('rejects reconciliation when request parameters differ or reservation state is not RECOVERY_REQUIRED', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Wrong plan code
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'STARTER', billableStaffSeats: 5, idempotencyKey },
        'PLN_some_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );

    // Wrong seat count
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'TEAM', billableStaffSeats: 20, idempotencyKey },
        'PLN_some_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );

    // Non-existent reservation
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: 'non-existent-key' },
        'PLN_some_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationError
    );

    // Cannot reconcile a freshly RESERVED reservation (not in RECOVERY_REQUIRED)
    const freshKey = `plan-key-${randomUUID()}`;
    await service.reserve({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: freshKey });
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: freshKey },
        'PLN_some_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationError
    );

    // Cannot reconcile a FAILED reservation
    const failKey = `plan-key-${randomUUID()}`;
    gateway.setNextPlanResult(new PaymentGatewayError('PROVIDER_FAILURE', 'Provider rejected plan'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: failKey }, gateway),
      (error: unknown) => error instanceof PaymentGatewayError
    );
    await assert.rejects(
      service.resolveReconciliation(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: failKey },
        'PLN_some_code',
        gateway
      ),
      (error: unknown) => error instanceof ProviderPlanReservationError
    );
  });

  it('protects concurrent reconciliation and prevents conflicting plan overwrite', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-${randomUUID()}`;

    gateway.setNextPlanResult(new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    const winningCode = 'PLN_concurrent_win';
    gateway.setPlanLookupResult(winningCode, {
      providerPlanId: '33333',
      planCode: winningCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    // Multiple concurrent reconciliations for the same winning plan converge
    const [res1, res2, res3] = await Promise.all([
      service.resolveReconciliation({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, winningCode, gateway),
      service.resolveReconciliation({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, winningCode, gateway),
      service.resolveReconciliation({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, winningCode, gateway),
    ]);

    assert.ok(res1 && res2 && res3);
    assert.equal(res1.providerPlanCode, winningCode);
    assert.deepEqual(res2, res1);
    assert.deepEqual(res3, res1);

    // Another candidate cannot overwrite the completed reservation
    const conflictingCode = 'PLN_concurrent_conflict';
    gateway.setPlanLookupResult(conflictingCode, {
      providerPlanId: '44444',
      planCode: conflictingCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    await assert.rejects(
      service.resolveReconciliation({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, conflictingCode, gateway),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );
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

  it('never calls provider createPlan on an existing RESERVED reservation', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const idempotencyKey = `plan-key-${randomUUID()}`;

    // Establish reservation in state RESERVED
    await service.reserve({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey });

    let createPlanCalls = 0;
    const spyGateway = {
      ...new MockPaystackGateway(),
      async createPlan() {
        createPlanCalls += 1;
        throw new Error('Should not be called');
      },
    };

    await assert.rejects(
      service.getOrCreatePlan(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
        spyGateway as any
      ),
      (error: unknown) => error instanceof ProviderPlanReservationConflictError
    );

    assert.equal(createPlanCalls, 0);
  });

  it('treats network failures and HTTP errors as uncertain outcomes requiring recovery', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();

    // 1. Network failure
    const netKey = `plan-key-net-${randomUUID()}`;
    gateway.setNextPlanResult(new PaymentGatewayError('NETWORK', 'Socket hang up'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: netKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Re-attempt fails closed
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: netKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // 2. HTTP 502/500 error
    const httpKey = `plan-key-http-${randomUUID()}`;
    gateway.setNextPlanResult(new PaymentGatewayError('HTTP', 'Paystack 502 Bad Gateway'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: httpKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Re-attempt fails closed
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: httpKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('treats malformed provider responses and attribute mismatches as uncertain outcomes', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();

    // 1. Invalid response
    const invalidKey = `plan-key-inv-${randomUUID()}`;
    gateway.setNextPlanResult(new PaymentGatewayError('INVALID_RESPONSE', 'Invalid plan ID from Paystack'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: invalidKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // 2. Verification mismatch
    const mismatchKey = `plan-key-mis-${randomUUID()}`;
    gateway.setNextPlanResult(new PaymentGatewayError('VERIFICATION_MISMATCH', 'Currency mismatched'));
    await assert.rejects(
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey: mismatchKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
  });

  it('protects crash-style pre-call state and allows subsequent verified recovery', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const gateway = new MockPaystackGateway();
    const idempotencyKey = `plan-key-crash-${randomUUID()}`;

    // Establish reservation
    await service.reserve({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey });

    // Simulate pre-call transition having occurred before crash
    const scope = `team-provider-plan:${teamId}`;
    const record = await prisma.billingIdempotencyKey.findUniqueOrThrow({
      where: { scope_key: { scope, key: idempotencyKey } },
    });
    const current = record.responseBody as any;
    await prisma.billingIdempotencyKey.update({
      where: { scope_key: { scope, key: idempotencyKey } },
      data: {
        responseBody: {
          ...current,
          state: 'RECOVERY_REQUIRED',
          failureCode: 'EXECUTION_PENDING',
          failureMessage: 'Provider plan creation initiated; outcome pending verification',
          updatedAt: new Date().toISOString(),
        },
      },
    });

    // Caller retrying getOrCreatePlan is blocked from calling createPlan again
    let calls = 0;
    const trackingGateway = {
      ...gateway,
      async createPlan() {
        calls += 1;
        throw new Error('Should not be called');
      },
    };

    await assert.rejects(
      service.getOrCreatePlan(
        { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
        trackingGateway as any
      ),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );
    assert.equal(calls, 0);

    // Recovery succeeds when verified plan exists
    const candidatePlanCode = 'PLN_recovered_after_crash';
    gateway.setPlanLookupResult(candidatePlanCode, {
      providerPlanId: '77777',
      planCode: candidatePlanCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    const recovered = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      candidatePlanCode,
      gateway
    );
    assert.ok(recovered);
    assert.equal(recovered.state, 'COMPLETED');
    assert.equal(recovered.providerPlanCode, candidatePlanCode);
  });

  it('treats post-provider persistence failure as RECOVERY_REQUIRED and allows recovery', async () => {
    const { teamId } = await createTeam();
    const idempotencyKey = `plan-key-persist-${randomUUID()}`;
    const gateway = new MockPaystackGateway();

    let failCompletionUpdate = true;
    const failingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'billingIdempotencyKey') {
          const originalKey = target.billingIdempotencyKey;
          return new Proxy(originalKey, {
            get(kTarget, kProp, kReceiver) {
              if (kProp === 'update') {
                return async (args: any) => {
                  if (failCompletionUpdate && args?.data?.status === 'SUCCEEDED') {
                    throw new Error('Database connection dropped during completion update');
                  }
                  return originalKey.update(args);
                };
              }
              return Reflect.get(kTarget, kProp, kReceiver);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const failingService = new ProviderPlanReservationService(failingPrisma as any);

    await assert.rejects(
      failingService.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, gateway),
      (error: unknown) => error instanceof ProviderPlanRecoveryRequiredError
    );

    // Verify DB record is in RECOVERY_REQUIRED
    const service = new ProviderPlanReservationService(prisma);
    const scope = `team-provider-plan:${teamId}`;
    const record = await prisma.billingIdempotencyKey.findUnique({
      where: { scope_key: { scope, key: idempotencyKey } },
    });
    assert.ok(record);
    assert.equal((record.responseBody as any).state, 'RECOVERY_REQUIRED');

    // Recovery succeeds
    failCompletionUpdate = false;
    const candidateCode = 'PLN_mock_5000_1';
    gateway.setPlanLookupResult(candidateCode, {
      providerPlanId: '1',
      planCode: candidateCode,
      name: `Rota TEAM (10 seats) - team:${teamId}`,
      amountCents: 5_000,
      currency: 'USD',
      interval: 'monthly',
    });

    const recovered = await service.resolveReconciliation(
      { teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey },
      candidateCode,
      gateway
    );
    assert.ok(recovered);
    assert.equal(recovered.state, 'COMPLETED');
  });

  it('protects concurrent getOrCreatePlan execution without duplicate provider plan creation', async () => {
    const { teamId } = await createTeam();
    const service = new ProviderPlanReservationService(prisma);
    const idempotencyKey = `plan-key-concurrent-${randomUUID()}`;

    let createPlanCount = 0;
    const delayedGateway = {
      ...new MockPaystackGateway(),
      async createPlan(planInput: any) {
        createPlanCount += 1;
        await new Promise((r) => setTimeout(r, 50));
        return {
          providerPlanId: '88888',
          planCode: `PLN_concurrent_${planInput.amountCents}`,
          name: planInput.name,
          amountCents: planInput.amountCents,
          interval: 'monthly' as const,
          currency: 'USD' as const,
        };
      },
    };

    const results = await Promise.allSettled([
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, delayedGateway as any),
      service.getOrCreatePlan({ teamId, planCode: 'TEAM', billableStaffSeats: 10, idempotencyKey }, delayedGateway as any),
    ]);

    // createPlan was called at most once
    assert.equal(createPlanCount, 1);

    // At least one succeeded or both converged safely
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1);
  });
});
