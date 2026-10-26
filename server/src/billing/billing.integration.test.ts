import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { BillingService } from '../services/billing.service';
import { MockPaystackGateway, PaymentGatewayError, type InitializePaymentInput, type PaymentInitialization, type VerifyPaymentInput, type VerifiedPayment } from './payments';

type Auth = { user: { id: string }; accessToken: string };
type Team = { id: string };

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
let baseUrl: string;
let server: ReturnType<typeof app.listen>;

const request = (path: string, options: RequestInit = {}) => fetch(`${baseUrl}${path}`, options);

const register = async (): Promise<Auth> => {
  const response = await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `billing-test-${randomUUID()}@example.com`, name: 'Billing Test', password: 'correct horse battery staple' }),
  });
  const body = await response.json() as Auth;
  createdUserIds.push(body.user.id);
  return body;
};

const createTeam = async (auth: Auth): Promise<Team> => {
  const response = await request('/teams', {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Billing Team ${randomUUID()}` }),
  });
  const body = await response.json() as { team: Team };
  createdTeamIds.push(body.team.id);
  return body.team;
};

const addMember = (owner: Auth, teamId: string, userId: string, role: 'STAFF' | 'MANAGER') => request(`/teams/${teamId}/members`, {
  method: 'POST',
  headers: { authorization: `Bearer ${owner.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ userId, role }),
});

const checkout = (auth: Auth, teamId: string, key: string, planCode = 'STARTER') => request(`/teams/${teamId}/billing/checkout`, {
  method: 'POST',
  headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json', 'Idempotency-Key': key },
  body: JSON.stringify({ planCode }),
});

class TimeoutGateway implements PaymentGatewayForTest {
  async initializeTransaction(_input: InitializePaymentInput): Promise<PaymentInitialization> {
    throw new PaymentGatewayError('TIMEOUT', 'timeout');
  }
  async verifyTransaction(_input: VerifyPaymentInput): Promise<VerifiedPayment> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }
}

class FailureGateway implements PaymentGatewayForTest {
  async initializeTransaction(_input: InitializePaymentInput): Promise<PaymentInitialization> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'provider rejected initialization');
  }
  async verifyTransaction(_input: VerifyPaymentInput): Promise<VerifiedPayment> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }
}

class BlockingGateway implements PaymentGatewayForTest {
  calls = 0;
  private releaseInitialization!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.releaseInitialization = resolve;
  });

  async initializeTransaction(input: InitializePaymentInput): Promise<PaymentInitialization> {
    this.calls += 1;
    this.releaseInitialization();
    await new Promise<void>((resolve) => {
      this.releaseInitialization = resolve;
    });
    return {
      reference: input.reference,
      authorizationUrl: `https://mock.paystack.test/authorize/${input.reference}`,
      accessCode: `mock_${input.reference}`,
    };
  }

  async verifyTransaction(_input: VerifyPaymentInput): Promise<VerifiedPayment> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }

  release(): void {
    this.releaseInitialization();
  }
}

interface PaymentGatewayForTest {
  initializeTransaction(input: InitializePaymentInput): Promise<PaymentInitialization>;
  verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment>;
}

describe('billing checkout API', () => {
  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const subscriptions = await prisma.billingSubscription.findMany({ where: { teamId: { in: createdTeamIds } }, select: { id: true } });
    const invoices = await prisma.billingInvoice.findMany({ where: { subscriptionId: { in: subscriptions.map(({ id }) => id) } }, select: { id: true } });
    await prisma.billingPaymentAttempt.deleteMany({ where: { invoiceId: { in: invoices.map(({ id }) => id) } } });
    await prisma.billingIdempotencyKey.deleteMany({ where: { teamId: { in: createdTeamIds } } });
    await prisma.billingInvoice.deleteMany({ where: { id: { in: invoices.map(({ id }) => id) } } });
    await prisma.billingSubscription.deleteMany({ where: { id: { in: subscriptions.map(({ id }) => id) } } });
    await prisma.teamMembership.deleteMany({ where: { teamId: { in: createdTeamIds } } });
    await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('exposes only active server-owned plans publicly', async () => {
    const response = await request('/billing/plans');
    const body = await response.json() as { plans: Array<{ code: string; monthlyPriceCents: number }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.plans.map((plan) => plan.code), ['STARTER', 'TEAM', 'BUSINESS']);
    assert.equal(body.plans.find((plan) => plan.code === 'STARTER')?.monthlyPriceCents, 2_000);
  });

  it('enforces owner-only billing access and isolates teams', async () => {
    const owner = await register();
    const staff = await register();
    const manager = await register();
    const outsider = await register();
    const team = await createTeam(owner);
    assert.equal((await addMember(owner, team.id, staff.user.id, 'STAFF')).status, 201);
    assert.equal((await addMember(owner, team.id, manager.user.id, 'MANAGER')).status, 201);
    assert.equal((await request(`/teams/${team.id}/billing`)).status, 401);
    assert.equal((await request(`/teams/${team.id}/billing`, { headers: { authorization: `Bearer ${staff.accessToken}` } })).status, 403);
    assert.equal((await request(`/teams/${team.id}/billing`, { headers: { authorization: `Bearer ${manager.accessToken}` } })).status, 403);
    assert.equal((await request(`/teams/${team.id}/billing`, { headers: { authorization: `Bearer ${outsider.accessToken}` } })).status, 404);
    const response = await request(`/teams/${team.id}/billing`, { headers: { authorization: `Bearer ${owner.accessToken}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).billing.subscription, null);
  });

  it('creates a server-priced pending checkout and recovers the same operation', async () => {
    const owner = await register();
    const staff = await register();
    const lateStaff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');
    const key = `checkout-${randomUUID()}`;
    const first = await checkout(owner, team.id, key);
    const firstBody = await first.json() as { checkout: { state: string; subscriptionId: string; invoiceId: string; paymentAttemptId: string; amountCents: number; authorizationUrl?: string } };
    assert.equal(first.status, 202);
    assert.equal(firstBody.checkout.state, 'CHECKOUT_PENDING');
    assert.equal(firstBody.checkout.amountCents, 2_000);
    assert.match(firstBody.checkout.authorizationUrl!, /^https:\/\/mock\.paystack\.test\//);

    await addMember(owner, team.id, lateStaff.user.id, 'STAFF');

    const replay = await checkout(owner, team.id, key);
    const replayBody = await replay.json() as { checkout: typeof firstBody.checkout };
    assert.equal(replay.status, 202);
    assert.deepEqual(replayBody.checkout, firstBody.checkout);

    const stored = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: firstBody.checkout.paymentAttemptId }, include: { invoice: { include: { subscription: true } }, idempotencyRecord: true } });
    assert.equal(stored.amountCents, 2_000);
    assert.equal(stored.status, 'PENDING');
    assert.equal(stored.invoice.status, 'DRAFT');
    assert.equal(stored.invoice.subscription.status, 'PENDING_CHECKOUT');
    assert.equal(stored.idempotencyRecord?.id, stored.idempotencyKeyId);

    const price = await prisma.billingPlanPrice.findFirstOrThrow({ where: { plan: { code: 'STARTER' }, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
    const originalPrice = price.monthlyPriceCents;
    await prisma.billingPlanPrice.update({ where: { id: price.id }, data: { monthlyPriceCents: 9_999 } });
    try {
      const unavailableCatalogReplay = await checkout(owner, team.id, key);
      const unavailableBody = await unavailableCatalogReplay.json() as { checkout: typeof firstBody.checkout };
      assert.equal(unavailableCatalogReplay.status, 202);
      assert.deepEqual(unavailableBody.checkout, firstBody.checkout);
    } finally {
      await prisma.billingPlanPrice.update({ where: { id: price.id }, data: { monthlyPriceCents: originalPrice } });
    }
  });

  it('rejects changed parameters for an idempotency key and existing subscriptions', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `conflict-${randomUUID()}`;
    assert.equal((await checkout(owner, team.id, key)).status, 202);
    assert.equal((await checkout(owner, team.id, key, 'TEAM')).status, 409);
    assert.equal((await checkout(owner, team.id, `other-${randomUUID()}`)).status, 409);
    assert.equal((await checkout(owner, team.id, 'short')).status, 400);
    assert.equal((await checkout(owner, team.id, `invalid-${randomUUID()}`, 'NOT_A_PLAN')).status, 400);
  });

  it('converges concurrent identical requests to one pending operation', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `concurrent-${randomUUID()}`;
    const responses = await Promise.all([checkout(owner, team.id, key), checkout(owner, team.id, key)]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ checkout: { subscriptionId: string; paymentAttemptId: string } }>));
    assert.deepEqual(bodies[0].checkout, bodies[1].checkout);
    assert.equal((await prisma.billingSubscription.count({ where: { teamId: team.id } })), 1);
    assert.equal((await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } })), 1);
  });

  it('does not allow concurrent conflicting requests to overwrite the operation', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `concurrent-conflict-${randomUUID()}`;
    const responses = await Promise.all([checkout(owner, team.id, key, 'STARTER'), checkout(owner, team.id, key, 'TEAM')]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [202, 409]);
    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 1);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 1);
  });

  it('preserves a timeout as recoverable without creating a second attempt', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `timeout-${randomUUID()}`;
    const timeoutService = new BillingService(prisma, new TimeoutGateway());
    const result = await timeoutService.checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
    const replay = await new BillingService(prisma, new MockPaystackGateway()).checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    assert.equal(replay.state, 'RECOVERY_REQUIRED');
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 1);
  });

  it('does not reinitialize while another request is in flight or after a simulated crash', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `blocked-${randomUUID()}`;
    const gateway = new BlockingGateway();
    const firstPromise = new BillingService(prisma, gateway).checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    await gateway.started;

    const concurrent = await new BillingService(prisma, new MockPaystackGateway()).checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    assert.equal(concurrent.state, 'RESERVED');
    assert.equal(concurrent.recoveryRequired, true);
    gateway.release();
    const first = await firstPromise;
    assert.equal(first.state, 'CHECKOUT_PENDING');
    assert.equal(gateway.calls, 1);

    const record = await prisma.billingIdempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: `team-billing-checkout:${team.id}`, key } } });
    const persisted = record.responseBody as Record<string, unknown>;
    const { authorizationUrl: _authorizationUrl, accessCode: _accessCode, ...reserved } = persisted;
    await prisma.billingIdempotencyKey.update({ where: { id: record.id }, data: { responseBody: { ...reserved, state: 'RESERVED' } } });
    const afterCrashGateway = new BlockingGateway();
    const recovered = await new BillingService(prisma, afterCrashGateway).checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    assert.equal(recovered.state, 'RESERVED');
    assert.equal(recovered.recoveryRequired, true);
    assert.equal(afterCrashGateway.calls, 0);
  });

  it('preserves known provider failure without creating a second attempt', async () => {
    const owner = await register();
    const team = await createTeam(owner);
    const key = `failure-${randomUUID()}`;
    const failureService = new BillingService(prisma, new FailureGateway());
    await assert.rejects(
      failureService.checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key),
      (error: unknown) => error instanceof Error && error.message === 'Checkout initialization failed'
    );
    const replay = await new BillingService(prisma, new MockPaystackGateway()).checkout(team.id, owner.user.id, { planCode: 'STARTER' }, key);
    assert.equal(replay.state, 'FAILED');
    assert.equal(replay.statusCode, 502);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 1);
    assert.equal((await prisma.billingPaymentAttempt.findFirstOrThrow({ where: { invoice: { subscription: { teamId: team.id } } } })).status, 'FAILED');
  });
});
