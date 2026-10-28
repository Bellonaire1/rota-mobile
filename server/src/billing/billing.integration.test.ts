import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { BillingIdempotencyStatus } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../database/prisma';
import { billingService, BillingService } from '../services/billing.service';
import { env } from '../config/env';
import { PaystackWebhookService } from '../services/paystack-webhook.service';
import {
  MockPaystackGateway,
  PaymentGatewayError,
  type CreatePlanInput,
  type FetchPlanByCodeInput,
  type InitializePaymentInput,
  type PaymentInitialization,
  type ProviderPlan,
  type VerifyPaymentInput,
  type VerifiedPayment,
} from './payments';
import { ProviderPlanReservationService } from '../services/provider-plan-reservation.service';
import { reconciliationIntegrationSkipReason } from '../services/reconciliation-test-safety';

type Auth = { user: { id: string }; accessToken: string };
type Team = { id: string };

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const webhookEventIds: string[] = [];
const webhookSecret = 'paystack-webhook-test-secret';
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

const checkout = (
  auth: Auth,
  teamId: string,
  key: string,
  planCode = 'STARTER',
  options: { recurring?: boolean; planReservationKey?: string } = {}
) => request(`/teams/${teamId}/billing/checkout`, {
  method: 'POST',
  headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json', 'Idempotency-Key': key },
  body: JSON.stringify({ planCode, ...options }),
});

const signedWebhook = (body: string, signatureBody = body) => request('/billing/webhooks/paystack', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', webhookSecret).update(Buffer.from(signatureBody)).digest('hex'),
  },
  body,
});

class TimeoutGateway implements PaymentGatewayForTest {
  async initializeTransaction(_input: InitializePaymentInput): Promise<PaymentInitialization> {
    throw new PaymentGatewayError('TIMEOUT', 'timeout');
  }
  async verifyTransaction(_input: VerifyPaymentInput): Promise<VerifiedPayment> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }
  async createPlan(_input: CreatePlanInput): Promise<ProviderPlan> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }
  async fetchPlanByCode(_input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
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
  async createPlan(_input: CreatePlanInput): Promise<ProviderPlan> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }
  async fetchPlanByCode(_input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
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

  async createPlan(_input: CreatePlanInput): Promise<ProviderPlan> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }

  async fetchPlanByCode(_input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
    throw new PaymentGatewayError('PROVIDER_FAILURE', 'not used');
  }

  release(): void {
    this.releaseInitialization();
  }
}

interface PaymentGatewayForTest {
  initializeTransaction(input: InitializePaymentInput): Promise<PaymentInitialization>;
  verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment>;
  createPlan(input: CreatePlanInput): Promise<ProviderPlan>;
  fetchPlanByCode(input: FetchPlanByCodeInput): Promise<ProviderPlan | null>;
}

describe('billing checkout API', { concurrency: false, skip: reconciliationIntegrationSkipReason() }, () => {
  before(async () => {
    env.PAYSTACK_TEST_SECRET_KEY = webhookSecret;
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const subscriptions = await prisma.billingSubscription.findMany({ where: { teamId: { in: createdTeamIds } }, select: { id: true } });
    await prisma.billingWebhookEvent.deleteMany({ where: { id: { in: webhookEventIds } } });
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

  it('accepts a verified Paystack webhook without activating billing', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { id: randomUUID(), amount: 2000 } });
    const response = await signedWebhook(body);
    assert.equal(response.status, 200);

    const event = await prisma.billingWebhookEvent.findFirstOrThrow({ where: { eventType: 'charge.success' }, orderBy: { receivedAt: 'desc' } });
    webhookEventIds.push(event.id);
    assert.equal(event.provider, 'paystack');
    assert.equal(event.status, 'RECEIVED');
    assert.equal(event.attemptCount, 0);
    assert.equal(event.processedAt, null);
    assert.deepEqual(event.payload, JSON.parse(body));
  });

  it('rejects invalid signatures and does not persist the webhook', async () => {
    const eventType = `invalid.signature.${randomUUID()}`;
    const body = JSON.stringify({ event: eventType, data: { id: randomUUID() } });
    const response = await request('/billing/webhooks/paystack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': '00'.repeat(64) },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal(await prisma.billingWebhookEvent.count({ where: { eventType } }), 0);
  });

  it('uses the exact raw body for verification and deduplicates identical deliveries', async () => {
    const body = '{"event":"invoice.create","data":{"id":"raw-body-1","amount":2000}}';
    const first = await signedWebhook(body);
    const replay = await signedWebhook(body);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    const events = await prisma.billingWebhookEvent.findMany({ where: { eventType: 'invoice.create' } });
    assert.equal(events.length, 1);
    webhookEventIds.push(events[0].id);

    const reformatted = '{ "event": "invoice.create", "data": { "id": "raw-body-1", "amount": 2000 } }';
    const mismatched = await signedWebhook(reformatted, body);
    assert.equal(mismatched.status, 401);
  });

  it('derives the persisted payload only from the verified raw bytes', async () => {
    let persistedPayload: unknown;
    const database = {
      billingWebhookEvent: {
        create: async ({ data }: { data: { payload: unknown } }) => { persistedPayload = data.payload; },
      },
    } as unknown as typeof prisma;
    const service = new PaystackWebhookService(database);
    const body = Buffer.from('{"event":"charge.success.raw-source","data":{"id":"raw-source-1"}}');
    const signature = createHmac('sha512', webhookSecret).update(body).digest('hex');

    await service.receive(body, signature);

    assert.deepEqual(persistedPayload, JSON.parse(body.toString('utf8')));
  });

  it('converges concurrent identical webhook deliveries to one event', async () => {
    const body = JSON.stringify({ event: `charge.success.concurrent.${randomUUID()}`, data: { id: randomUUID() } });
    const responses = await Promise.all(Array.from({ length: 3 }, () => signedWebhook(body)));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    const events = await prisma.billingWebhookEvent.findMany({ where: { eventType: JSON.parse(body).event } });
    assert.equal(events.length, 1);
    webhookEventIds.push(events[0].id);
  });

  it('does not overwrite an event status when a delivery is replayed', async () => {
    const body = JSON.stringify({ event: `charge.success.immutable.${randomUUID()}`, data: { id: randomUUID() } });
    assert.equal((await signedWebhook(body)).status, 200);
    const created = await prisma.billingWebhookEvent.findFirstOrThrow({ where: { eventType: JSON.parse(body).event } });
    webhookEventIds.push(created.id);
    await prisma.billingWebhookEvent.update({ where: { id: created.id }, data: { status: 'PROCESSING', attemptCount: 4, lastError: 'worker in progress' } });

    assert.equal((await signedWebhook(body)).status, 200);
    const replayed = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(replayed.status, 'PROCESSING');
    assert.equal(replayed.attemptCount, 4);
    assert.equal(replayed.lastError, 'worker in progress');
  });

  it('propagates persistence failures instead of acknowledging the webhook', async () => {
    const failingDatabase = {
      billingWebhookEvent: {
        create: async () => { throw new Error('database unavailable'); },
      },
    } as unknown as typeof prisma;
    const service = new PaystackWebhookService(failingDatabase);
    const body = JSON.stringify({ event: 'charge.success.persistence-failure', data: { id: randomUUID() } });
    await assert.rejects(
      service.receive(Buffer.from(body), createHmac('sha512', webhookSecret).update(body).digest('hex')),
      (error: unknown) => error instanceof Error && error.message === 'database unavailable'
    );
  });

  it('continues parsing existing JSON API requests', async () => {
    const response = await request('/billing/plans', {
      headers: { accept: 'application/json' },
    });
    assert.equal(response.status, 200);
  });

  it('rejects missing signatures and malformed signed JSON', async () => {
    const missingSignature = await request('/billing/webhooks/paystack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'charge.success.missing-signature', data: {} }),
    });
    assert.equal(missingSignature.status, 401);

    const malformedBody = '{"event":"charge.success.malformed","data":';
    const malformed = await request('/billing/webhooks/paystack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': createHmac('sha512', webhookSecret).update(malformedBody).digest('hex'),
      },
      body: malformedBody,
    });
    assert.equal(malformed.status, 400);
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

  it('performs recurring plan-linked checkout with verified COMPLETED plan reservation', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-key-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    const planGateway = billingService.gateway as MockPaystackGateway;
    const plan = await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, planGateway);
    assert.equal(plan.state, 'COMPLETED');
    assert.ok(plan.providerPlanCode);

    const checkoutKey = `checkout-rec-${randomUUID()}`;
    const response = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { checkout: { state: string; amountCents: number; recurring?: boolean; providerPlanCode?: string; authorizationUrl?: string } };
    assert.equal(body.checkout.state, 'CHECKOUT_PENDING');
    assert.equal(body.checkout.amountCents, 2_000);
    assert.equal(body.checkout.recurring, true);
    assert.equal(body.checkout.providerPlanCode, plan.providerPlanCode);
    assert.match(body.checkout.authorizationUrl!, /^https:\/\/mock\.paystack\.test\//);

    const record = await prisma.billingIdempotencyKey.findUniqueOrThrow({
      where: { scope_key: { scope: `team-billing-checkout:${team.id}`, key: checkoutKey } },
    });
    const persisted = record.responseBody as any;
    assert.equal(persisted.recurring, true);
    assert.equal(persisted.providerPlanCode, plan.providerPlanCode);
  });

  it('enforces separate idempotency identities between recurring and one-off checkout', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const key = `key-distinct-${randomUUID()}`;
    const oneOffRes = await checkout(owner, team.id, key, 'STARTER');
    assert.equal(oneOffRes.status, 202);

    const conflictRes = await checkout(owner, team.id, key, 'STARTER', { recurring: true });
    assert.equal(conflictRes.status, 409);
    const errorBody = await conflictRes.json() as { message: string };
    assert.match(errorBody.message, /different checkout parameters/i);
  });

  it('rejects recurring checkout when plan reservation is missing', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const checkoutKey = `checkout-noplan-${randomUUID()}`;
    const response = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: `nonexistent-plan-${randomUUID()}`,
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { message: string };
    assert.match(body.message, /No provider plan reservation found/i);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 0);
    assert.equal(await prisma.billingInvoice.count({ where: { subscription: { teamId: team.id } } }), 0);
  });

  it('rejects recurring checkout when plan reservation is not COMPLETED', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-inprog-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.reserve({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    });

    const checkoutKey = `checkout-inprog-${randomUUID()}`;
    const response = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { message: string };
    assert.match(body.message, /verified COMPLETED plan required/i);
  });

  it('rejects recurring checkout on seat count, tier, or amount mismatch', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-mismatch-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, billingService.gateway as MockPaystackGateway);

    const staff2 = await register();
    await addMember(owner, team.id, staff2.user.id, 'STAFF');

    const responseSeats = await checkout(owner, team.id, `chk-seats-${randomUUID()}`, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(responseSeats.status, 409);
    const bodySeats = await responseSeats.json() as { message: string };
    assert.match(bodySeats.message, /seat count mismatch/i);

    const responseTier = await checkout(owner, team.id, `chk-tier-${randomUUID()}`, 'TEAM', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(responseTier.status, 409);
    const bodyTier = await responseTier.json() as { message: string };
    assert.match(bodyTier.message, /tier mismatch/i);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 0);
  });

  it('supports idempotent replay of recurring checkout without duplicate records', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-replay-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, billingService.gateway as MockPaystackGateway);

    const checkoutKey = `checkout-replay-${randomUUID()}`;
    const first = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(first.status, 202);
    const firstBody = await first.json();

    const replay = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(replay.status, 202);
    const replayBody = await replay.json();
    assert.deepEqual(replayBody, firstBody);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 1);
    assert.equal(await prisma.billingInvoice.count({ where: { subscription: { teamId: team.id } } }), 1);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 1);
  });

  it('rejects recurring checkout when provider-plan reservation is bound to another subscription', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-bound-${randomUUID()}`;
    const conflictingSubId = randomUUID();
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      subscriptionId: conflictingSubId,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, billingService.gateway as MockPaystackGateway);

    const checkoutKey = `checkout-bound-${randomUUID()}`;
    const response = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { message: string };
    assert.match(body.message, /already bound to another subscription/i);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 0);
    assert.equal(await prisma.billingInvoice.count({ where: { subscription: { teamId: team.id } } }), 0);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 0);
  });

  it('supports idempotent replay of legacy version-1 one-off checkout records', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const v1Key = `legacy-v1-${randomUUID()}`;
    const legacyCanonical = JSON.stringify({
      ownerId: owner.user.id,
      planCode: 'STARTER',
      teamId: team.id,
      version: 1,
    });
    const legacyHash = createHash('sha256').update(legacyCanonical).digest('hex');

    const mockCachedResponse = {
      state: 'CHECKOUT_PENDING',
      subscriptionId: randomUUID(),
      invoiceId: randomUUID(),
      paymentAttemptId: randomUUID(),
      providerReference: `rota-${team.id}-${randomUUID()}`,
      planCode: 'STARTER',
      priceId: randomUUID(),
      billableStaffSeats: 1,
      amountCents: 2000,
      currency: 'USD',
      authorizationUrl: 'https://checkout.paystack.com/legacy-test',
      accessCode: 'legacy-access-code',
    };

    await prisma.billingIdempotencyKey.create({
      data: {
        scope: `team-billing-checkout:${team.id}`,
        key: v1Key,
        requestHash: legacyHash,
        status: BillingIdempotencyStatus.SUCCEEDED,
        responseStatus: 202,
        responseBody: mockCachedResponse,
        teamId: team.id,
        userId: owner.user.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const responseOmitted = await checkout(owner, team.id, v1Key, 'STARTER');
    assert.equal(responseOmitted.status, 202);
    const bodyOmitted = await responseOmitted.json() as { checkout: Record<string, unknown> };
    assert.equal(bodyOmitted.checkout.authorizationUrl, 'https://checkout.paystack.com/legacy-test');
    assert.equal(bodyOmitted.checkout.accessCode, 'legacy-access-code');

    const responseFalse = await checkout(owner, team.id, v1Key, 'STARTER', { recurring: false });
    assert.equal(responseFalse.status, 202);
    const bodyFalse = await responseFalse.json() as { checkout: Record<string, unknown> };
    assert.equal(bodyFalse.checkout.authorizationUrl, 'https://checkout.paystack.com/legacy-test');
  });

  it('rejects reusing the same idempotency key across one-off and recurring modes', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-cross-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, billingService.gateway as MockPaystackGateway);

    const sharedKey = `shared-key-${randomUUID()}`;

    const firstOneOff = await checkout(owner, team.id, sharedKey, 'STARTER');
    assert.equal(firstOneOff.status, 202);

    const secondRecurring = await checkout(owner, team.id, sharedKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(secondRecurring.status, 409);
    const body = await secondRecurring.json() as { message: string };
    assert.match(body.message, /different checkout parameters/i);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 1);
  });

  it('rejects reusing the same idempotency key with different planReservationKeys', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey1 = `plan-key-1-${randomUUID()}`;
    const planKey2 = `plan-key-2-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey1,
    }, billingService.gateway as MockPaystackGateway);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey2,
    }, billingService.gateway as MockPaystackGateway);

    const sharedKey = `shared-rec-key-${randomUUID()}`;

    const first = await checkout(owner, team.id, sharedKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey1,
    });
    assert.equal(first.status, 202);

    const second = await checkout(owner, team.id, sharedKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey2,
    });
    assert.equal(second.status, 409);
    const body = await second.json() as { message: string };
    assert.match(body.message, /different checkout parameters/i);
  });

  it('rejects recurring checkout when provider-plan reservation has an invalid request hash', async () => {
    const owner = await register();
    const staff = await register();
    const team = await createTeam(owner);
    await addMember(owner, team.id, staff.user.id, 'STAFF');

    const planKey = `plan-badhash-${randomUUID()}`;
    const planService = new ProviderPlanReservationService(prisma);
    await planService.getOrCreatePlan({
      teamId: team.id,
      planCode: 'STARTER',
      billableStaffSeats: 1,
      idempotencyKey: planKey,
    }, billingService.gateway as MockPaystackGateway);

    await prisma.billingIdempotencyKey.update({
      where: {
        scope_key: {
          scope: `team-provider-plan:${team.id}`,
          key: planKey,
        },
      },
      data: {
        requestHash: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    const checkoutKey = `checkout-badhash-${randomUUID()}`;
    const response = await checkout(owner, team.id, checkoutKey, 'STARTER', {
      recurring: true,
      planReservationKey: planKey,
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { message: string };
    assert.match(body.message, /request hash mismatch/i);

    assert.equal(await prisma.billingSubscription.count({ where: { teamId: team.id } }), 0);
    assert.equal(await prisma.billingInvoice.count({ where: { subscription: { teamId: team.id } } }), 0);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { invoice: { subscription: { teamId: team.id } } } }), 0);
  });
});
