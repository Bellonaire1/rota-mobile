import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MockPaystackGateway,
  PaystackGateway,
  PaymentGatewayError,
  type CreatePlanInput,
  type FetchPlanByCodeInput,
  type InitializePaymentInput,
  type PlanInitializationOptions,
  type ProviderPlan,
} from './payments';
import { calculateSeatPricing } from './pricing';

const input = (overrides: Partial<InitializePaymentInput> = {}): InitializePaymentInput => ({
  amountCents: 2_000,
  currency: 'USD',
  customerEmail: 'billing@example.com',
  reference: 'rota-team-20261026-001',
  idempotencyKey: 'billing-operation-001',
  ...overrides,
});

const assertGatewayError = async (
  operation: Promise<unknown>,
  code: PaymentGatewayError['code']
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof PaymentGatewayError && error.code === code
  );
};

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('mock Paystack gateway', () => {
  it('keeps an initialized payment pending until success is explicitly simulated', async () => {
    const gateway = new MockPaystackGateway();
    const initialized = await gateway.initializeTransaction(input());
    await assertGatewayError(gateway.verifyTransaction({
      reference: initialized.reference,
      expectedAmountCents: 2_000,
      expectedCurrency: 'USD',
    }), 'PROVIDER_FAILURE');
    gateway.simulateSuccess(initialized.reference);
    const verified = await gateway.verifyTransaction({
      reference: initialized.reference,
      expectedAmountCents: 2_000,
      expectedCurrency: 'USD',
    });

    assert.equal(initialized.authorizationUrl, 'https://mock.paystack.test/authorize/rota-team-20261026-001');
    assert.deepEqual(verified, {
      reference: input().reference,
      providerTransactionId: 'mock_tx_rota-team-20261026-001',
      amountCents: 2_000,
      currency: 'USD',
      status: 'success',
    });
  });

  it('makes repeated initialization idempotent and rejects conflicting reuse', async () => {
    const gateway = new MockPaystackGateway();
    const first = await gateway.initializeTransaction(input());
    const second = await gateway.initializeTransaction(input());
    assert.deepEqual(second, first);
    await assertGatewayError(
      gateway.initializeTransaction(input({ amountCents: 5_000 })),
      'DUPLICATE_OPERATION'
    );
  });

  it('returns configured provider failures deterministically', async () => {
    const gateway = new MockPaystackGateway();
    await gateway.initializeTransaction(input());
    gateway.setVerificationResult(
      input().reference,
      new PaymentGatewayError('PROVIDER_FAILURE', 'payment was not successful')
    );
    await assertGatewayError(
      gateway.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD' }),
      'PROVIDER_FAILURE'
    );
  });

  it('supports explicit pending, failure, and success simulation states', async () => {
    const gateway = new MockPaystackGateway();
    await gateway.initializeTransaction(input());
    gateway.simulatePending(input().reference);
    await assertGatewayError(gateway.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD' }), 'PROVIDER_FAILURE');
    gateway.simulateFailure(input().reference);
    await assertGatewayError(gateway.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD' }), 'PROVIDER_FAILURE');
    gateway.simulateSuccess(input().reference);
    assert.equal((await gateway.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD' })).status, 'success');
  });
});

describe('payment input validation', () => {
  it('accepts Paystack reference punctuation and rejects unsupported punctuation', async () => {
    const gateway = new MockPaystackGateway();
    for (const reference of ['rota.team=2026-001', 'rota-team.2026=001']) {
      await gateway.initializeTransaction(input({ reference }));
    }
    for (const reference of ['rota_team-2026', 'rota:team-2026']) {
      await assertGatewayError(gateway.initializeTransaction(input({ reference })), 'VALIDATION');
    }
  });

  it('rejects USD amounts below Paystack minimum without a provider call', async () => {
    const gateway = new MockPaystackGateway();
    await assertGatewayError(gateway.initializeTransaction(input({ amountCents: 199 })), 'VALIDATION');
  });
});

describe('Paystack HTTP gateway', () => {
  it('initializes with server-calculated cents and verifies matching provider data', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (requests.length === 1) {
          return response({ status: true, data: {
            authorization_url: 'https://checkout.paystack.com/authorize',
            access_code: 'access_code',
            reference: input().reference,
          } });
        }
        return response({ status: true, data: {
          id: 12345,
          reference: input().reference,
          amount: 2_000,
          currency: 'USD',
          status: 'success',
          metadata: { mode: 'test' },
        } });
      },
    });

    await gateway.initializeTransaction(input());
    const verified = await gateway.verifyTransaction({
      reference: input().reference,
      expectedAmountCents: 2_000,
      expectedCurrency: 'USD',
      expectedMetadata: { mode: 'test' },
    });
    assert.equal(verified.providerTransactionId, '12345');
    assert.equal(requests[0].url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(requests[1].url, 'https://api.paystack.co/transaction/verify/rota-team-20261026-001');
    assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer sk_test_only-for-tests');
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      email: 'billing@example.com', amount: 2_000, currency: 'USD', reference: input().reference,
    });
  });

  it('rejects provider status failures, amount mismatches, and malformed responses', async () => {
    const failed = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'failed' }),
    });
    await assertGatewayError(failed.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    }), 'PROVIDER_FAILURE');

    const mismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1, reference: input().reference, amount: 1_000, currency: 'USD', status: 'success',
      } }),
    });
    await assertGatewayError(mismatch.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    }), 'VERIFICATION_MISMATCH');

    const malformed = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {} }),
    });
    await assertGatewayError(malformed.initializeTransaction(input()), 'INVALID_RESPONSE');
  });

  it('rejects malicious checkout URLs, invalid transaction IDs, and metadata mismatches', async () => {
    const maliciousUrl = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        authorization_url: 'https://evil.example/steal', access_code: 'access', reference: input().reference,
      } }),
    });
    await assertGatewayError(maliciousUrl.initializeTransaction(input()), 'INVALID_RESPONSE');

    for (const id of ['123', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidId = new PaystackGateway({
        secretKey: 'sk_test_only-for-tests',
        fetchImpl: async () => response({ status: true, data: {
          id, reference: input().reference, amount: 2_000, currency: 'USD', status: 'success',
        } }),
      });
      await assertGatewayError(invalidId.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD' }), 'VERIFICATION_MISMATCH');
    }

    const metadataMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 123, reference: input().reference, amount: 2_000, currency: 'USD', status: 'success', metadata: { mode: 'live' },
      } }),
    });
    await assertGatewayError(metadataMismatch.verifyTransaction({ reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD', expectedMetadata: { mode: 'test' } }), 'VERIFICATION_MISMATCH');
  });

  it('rejects non-Paystack API destinations even when supplied as a test option', () => {
    assert.throws(
      () => new PaystackGateway({ secretKey: 'sk_test_only-for-tests', baseUrl: 'https://evil.example' }),
      (error: unknown) => error instanceof PaymentGatewayError && error.code === 'CONFIGURATION'
    );
  });

  it('maps an aborted request to a timeout without leaking credentials', async () => {
    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    await assertGatewayError(gateway.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    }), 'TIMEOUT');
  });

  it('rejects live keys and client-invalid monetary inputs before any request', async () => {
    assert.throws(
      () => new PaystackGateway({ secretKey: 'sk_live_not-allowed' }),
      (error: unknown) => error instanceof PaymentGatewayError && error.code === 'CONFIGURATION'
    );
    const gateway = new PaystackGateway({ secretKey: 'sk_test_only-for-tests', fetchImpl: async () => response({}) });
    await assertGatewayError(gateway.initializeTransaction(input({ amountCents: 20.5 })), 'VALIDATION');
    await assertGatewayError(gateway.initializeTransaction(input({ reference: 'bad' })), 'VALIDATION');
  });

  it('extracts and validates Paystack verified customer code', async () => {
    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 12345,
        reference: input().reference,
        amount: 2_000,
        currency: 'USD',
        status: 'success',
        customer: { customer_code: 'CUS_1234567890abcdef' },
      } }),
    });
    const verified = await gateway.verifyTransaction({
      reference: input().reference,
      expectedAmountCents: 2_000,
      expectedCurrency: 'USD',
    });
    assert.equal(verified.providerCustomerId, 'CUS_1234567890abcdef');
  });

  it('omits providerCustomerId when Paystack customer data or customer_code is missing', async () => {
    const noCustomer = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 12345, reference: input().reference, amount: 2_000, currency: 'USD', status: 'success',
      } }),
    });
    const verified1 = await noCustomer.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    });
    assert.equal(verified1.providerCustomerId, undefined);

    const emptyCustomer = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 12345, reference: input().reference, amount: 2_000, currency: 'USD', status: 'success', customer: {},
      } }),
    });
    const verified2 = await emptyCustomer.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    });
    assert.equal(verified2.providerCustomerId, undefined);
  });

  it('rejects invalid Paystack customer data or malformed customer codes', async () => {
    for (const badCustomer of [
      'not-an-object',
      ['array'],
      { customer_code: 'NOT_CUS_PREFIX' },
      { customer_code: 'CUS_' },
      { customer_code: 12345 },
      { customer_code: 'CUS_invalid!' },
    ]) {
      const badGateway = new PaystackGateway({
        secretKey: 'sk_test_only-for-tests',
        fetchImpl: async () => response({ status: true, data: {
          id: 12345, reference: input().reference, amount: 2_000, currency: 'USD', status: 'success', customer: badCustomer,
        } }),
      });
      await assertGatewayError(badGateway.verifyTransaction({
        reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
      }), 'VERIFICATION_MISMATCH');
    }
  });

  it('supports simulated provider customer code and validates format in mock gateway', async () => {
    const gateway = new MockPaystackGateway();
    await gateway.initializeTransaction(input());
    gateway.simulateSuccess(input().reference, { providerCustomerId: 'CUS_mock_12345' });
    const verified = await gateway.verifyTransaction({
      reference: input().reference, expectedAmountCents: 2_000, expectedCurrency: 'USD',
    });
    assert.equal(verified.providerCustomerId, 'CUS_mock_12345');

    assert.throws(
      () => gateway.simulateSuccess(input().reference, { providerCustomerId: 'bad_code' }),
      (error: unknown) => error instanceof PaymentGatewayError && error.code === 'VALIDATION'
    );
  });
});

describe('recurring provider plan gateway', () => {
  const planInput = (overrides: Partial<CreatePlanInput> = {}): CreatePlanInput => {
    const pricing = calculateSeatPricing('TEAM', 10);
    return {
      name: 'Rota Team (10 seats)',
      amountCents: pricing.monthlyTotalCents,
      interval: 'monthly',
      currency: 'USD',
      description: 'Rota Team monthly plan',
      ...overrides,
    };
  };

  it('creates a monthly USD plan via MockPaystackGateway using calculated seat pricing', async () => {
    const gateway = new MockPaystackGateway();
    const input = planInput();
    const plan = await gateway.createPlan(input);

    assert.equal(plan.name, input.name);
    assert.equal(plan.amountCents, 5_000);
    assert.equal(plan.currency, 'USD');
    assert.equal(plan.interval, 'monthly');
    assert.match(plan.planCode, /^PLN_mock_5000_\d+$/);
    assert.match(plan.providerPlanId, /^\d+$/);
  });

  it('enforces input validation for provider plan creation', async () => {
    const gateway = new MockPaystackGateway();

    await assertGatewayError(
      gateway.createPlan(planInput({ currency: 'NGN' as never })),
      'VALIDATION'
    );
    await assertGatewayError(
      gateway.createPlan(planInput({ interval: 'yearly' as never })),
      'VALIDATION'
    );
    await assertGatewayError(
      gateway.createPlan(planInput({ amountCents: 150 })),
      'VALIDATION'
    );
    await assertGatewayError(
      gateway.createPlan(planInput({ name: '' })),
      'VALIDATION'
    );
  });

  it('supports configured provider failure in mock gateway', async () => {
    const gateway = new MockPaystackGateway();
    gateway.setNextPlanResult(new PaymentGatewayError('PROVIDER_FAILURE', 'Simulated failure'));
    await assertGatewayError(gateway.createPlan(planInput()), 'PROVIDER_FAILURE');
  });

  it('rejects mismatched mock plan configuration', async () => {
    const gateway = new MockPaystackGateway();

    gateway.setNextPlanResult({
      providerPlanId: '1',
      planCode: 'PLN_mock_123',
      name: 'Rota Team (10 seats)',
      amountCents: 9_999,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(gateway.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    gateway.setNextPlanResult({
      providerPlanId: '1',
      planCode: 'PLN_mock_123',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'NGN' as never,
    });
    await assertGatewayError(gateway.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    gateway.setNextPlanResult({
      providerPlanId: '1',
      planCode: 'PLN_mock_123',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'annually' as never,
      currency: 'USD',
    });
    await assertGatewayError(gateway.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    gateway.setNextPlanResult({
      providerPlanId: '1',
      planCode: 'NOT_PLN_FORMAT',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(gateway.createPlan(planInput()), 'INVALID_RESPONSE');
  });

  it('sends correct request and validates response in PaystackGateway', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return response({
          status: true,
          message: 'Plan created',
          data: {
            id: 28,
            plan_code: 'PLN_gx2wn530m0i3w3m',
            name: 'Rota Team (10 seats)',
            amount: 5_000,
            interval: 'monthly',
            currency: 'USD',
          },
        });
      },
    });

    const input = planInput();
    const result = await gateway.createPlan(input);

    assert.equal(capturedUrl, 'https://api.paystack.co/plan');
    assert.equal(capturedInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      name: input.name,
      amount: input.amountCents,
      interval: 'monthly',
      currency: 'USD',
      description: input.description,
    });
    assert.deepEqual(result, {
      providerPlanId: '28',
      planCode: 'PLN_gx2wn530m0i3w3m',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
  });

  it('rejects provider failure and invalid responses in PaystackGateway', async () => {
    const failureGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'Creation failed' }),
    });
    await assertGatewayError(failureGateway.createPlan(planInput()), 'PROVIDER_FAILURE');

    const emptyGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: null }),
    });
    await assertGatewayError(emptyGateway.createPlan(planInput()), 'INVALID_RESPONSE');

    const badIdGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: -1,
        plan_code: 'PLN_12345',
        name: 'Rota Team (10 seats)',
        amount: 5_000,
        interval: 'monthly',
        currency: 'USD',
      } }),
    });
    await assertGatewayError(badIdGateway.createPlan(planInput()), 'INVALID_RESPONSE');

    const badCodeGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1,
        plan_code: 'INVALID_CODE',
        name: 'Rota Team (10 seats)',
        amount: 5_000,
        interval: 'monthly',
        currency: 'USD',
      } }),
    });
    await assertGatewayError(badCodeGateway.createPlan(planInput()), 'INVALID_RESPONSE');
  });

  it('rejects plan response attribute mismatches in PaystackGateway', async () => {
    const amountMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1, plan_code: 'PLN_12345', name: 'Rota Team (10 seats)', amount: 4_000, interval: 'monthly', currency: 'USD',
      } }),
    });
    await assertGatewayError(amountMismatch.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    const currencyMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1, plan_code: 'PLN_12345', name: 'Rota Team (10 seats)', amount: 5_000, interval: 'monthly', currency: 'NGN',
      } }),
    });
    await assertGatewayError(currencyMismatch.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    const intervalMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1, plan_code: 'PLN_12345', name: 'Rota Team (10 seats)', amount: 5_000, interval: 'annually', currency: 'USD',
      } }),
    });
    await assertGatewayError(intervalMismatch.createPlan(planInput()), 'VERIFICATION_MISMATCH');

    const nameMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: {
        id: 1, plan_code: 'PLN_12345', name: 'Wrong Plan Name', amount: 5_000, interval: 'monthly', currency: 'USD',
      } }),
    });
    await assertGatewayError(nameMismatch.createPlan(planInput()), 'VERIFICATION_MISMATCH');
  });
});

describe('verified Paystack plan lookup', () => {
  const fetchInput = (overrides: Partial<FetchPlanByCodeInput> = {}): FetchPlanByCodeInput => ({
    planCode: 'PLN_gx2wn530m0i3w3m',
    expectedAmountCents: 5_000,
    expectedCurrency: 'USD',
    expectedInterval: 'monthly',
    expectedName: 'Rota Team (10 seats)',
    ...overrides,
  });

  const validPlanData = {
    id: 28,
    plan_code: 'PLN_gx2wn530m0i3w3m',
    name: 'Rota Team (10 seats)',
    amount: 5_000,
    interval: 'monthly',
    currency: 'USD',
  };

  it('retrieves and strictly validates an exact match in PaystackGateway', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return response({
          status: true,
          message: 'Plan retrieved',
          data: validPlanData,
        });
      },
    });

    const result = await gateway.fetchPlanByCode(fetchInput());

    assert.equal(capturedUrl, 'https://api.paystack.co/plan/PLN_gx2wn530m0i3w3m');
    assert.equal(capturedInit?.method, 'GET');
    assert.deepEqual(result, {
      providerPlanId: '28',
      planCode: 'PLN_gx2wn530m0i3w3m',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
  });

  it('returns null when plan is not found via HTTP 404 or not-found message', async () => {
    const notFound404Gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'Plan not found' }, 404),
    });
    const result404 = await notFound404Gateway.fetchPlanByCode(fetchInput());
    assert.equal(result404, null);

    const notFound200Gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'Plan not found' }, 200),
    });
    const result200 = await notFound200Gateway.fetchPlanByCode(fetchInput());
    assert.equal(result200, null);
  });

  it('rejects plan response attribute mismatches in PaystackGateway', async () => {
    // wrong amount
    const amountMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, amount: 4_000 } }),
    });
    await assertGatewayError(amountMismatch.fetchPlanByCode(fetchInput()), 'VERIFICATION_MISMATCH');

    // wrong currency
    const currencyMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, currency: 'NGN' } }),
    });
    await assertGatewayError(currencyMismatch.fetchPlanByCode(fetchInput()), 'VERIFICATION_MISMATCH');

    // wrong interval
    const intervalMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, interval: 'annually' } }),
    });
    await assertGatewayError(intervalMismatch.fetchPlanByCode(fetchInput()), 'VERIFICATION_MISMATCH');

    // wrong name
    const nameMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, name: 'Different Team Plan' } }),
    });
    await assertGatewayError(nameMismatch.fetchPlanByCode(fetchInput()), 'VERIFICATION_MISMATCH');

    // wrong code
    const codeMismatch = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, plan_code: 'PLN_different999' } }),
    });
    await assertGatewayError(codeMismatch.fetchPlanByCode(fetchInput()), 'VERIFICATION_MISMATCH');
  });

  it('rejects malformed responses and contradictory data in PaystackGateway', async () => {
    // invalid JSON
    const invalidJsonGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    await assertGatewayError(invalidJsonGateway.fetchPlanByCode(fetchInput()), 'INVALID_RESPONSE');

    // missing data
    const missingDataGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: null }),
    });
    await assertGatewayError(missingDataGateway.fetchPlanByCode(fetchInput()), 'INVALID_RESPONSE');

    // invalid plan ID
    const badIdGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, id: -5 } }),
    });
    await assertGatewayError(badIdGateway.fetchPlanByCode(fetchInput()), 'INVALID_RESPONSE');

    // invalid plan code format
    const badCodeFormatGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: { ...validPlanData, plan_code: 'INVALID_FORMAT' } }),
    });
    await assertGatewayError(badCodeFormatGateway.fetchPlanByCode(fetchInput()), 'INVALID_RESPONSE');

    // contradictory 404 with status: true
    const contradictoryGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: true, data: validPlanData }, 404),
    });
    await assertGatewayError(contradictoryGateway.fetchPlanByCode(fetchInput()), 'INVALID_RESPONSE');
  });

  it('rejects provider errors and HTTP failures in PaystackGateway', async () => {
    // HTTP 500 error
    const http500Gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'Server error' }, 500),
    });
    await assertGatewayError(http500Gateway.fetchPlanByCode(fetchInput()), 'HTTP');

    // HTTP 200 with status: false and generic error
    const providerFailureGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async () => response({ status: false, message: 'Internal service error' }, 200),
    });
    await assertGatewayError(providerFailureGateway.fetchPlanByCode(fetchInput()), 'PROVIDER_FAILURE');
  });

  it('enforces strict input validation for plan lookup', async () => {
    const gateway = new MockPaystackGateway();

    // invalid plan code
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ planCode: 'INVALID' })), 'VALIDATION');
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ planCode: '' })), 'VALIDATION');

    // invalid currency
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedCurrency: 'NGN' as never })), 'VALIDATION');

    // invalid interval
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedInterval: 'annually' as never })), 'VALIDATION');

    // invalid amount
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedAmountCents: 150 })), 'VALIDATION');
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedAmountCents: -500 })), 'VALIDATION');

    // invalid name
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedName: '' })), 'VALIDATION');
    await assertGatewayError(gateway.fetchPlanByCode(fetchInput({ expectedName: '   ' })), 'VALIDATION');
  });

  it('supports equivalent exact match, not found, configured error, and validation in MockPaystackGateway', async () => {
    const gateway = new MockPaystackGateway();

    // 1. Not found initially
    const notFound = await gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_uncreated_1' }));
    assert.equal(notFound, null);

    // 2. Explicitly configured as null
    gateway.setPlanLookupResult('PLN_mock_null_2', null);
    const configuredNull = await gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_null_2' }));
    assert.equal(configuredNull, null);

    // 3. Exact match on plan created via createPlan
    const created = await gateway.createPlan({
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    const fetchedCreated = await gateway.fetchPlanByCode({
      planCode: created.planCode,
      expectedAmountCents: 5_000,
      expectedCurrency: 'USD',
      expectedInterval: 'monthly',
      expectedName: 'Rota Team (10 seats)',
    });
    assert.deepEqual(fetchedCreated, created);

    // 4. Configured provider error
    gateway.setPlanLookupResult(
      'PLN_mock_err_3',
      new PaymentGatewayError('PROVIDER_FAILURE', 'Simulated lookup failure')
    );
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_err_3' })),
      'PROVIDER_FAILURE'
    );

    // 5. Mismatched attributes in mock lookup
    gateway.setPlanLookupResult('PLN_mock_mismatch_4', {
      providerPlanId: '10',
      planCode: 'PLN_mock_mismatch_4',
      name: 'Rota Team (10 seats)',
      amountCents: 4_000, // wrong amount
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_mismatch_4', expectedAmountCents: 5_000 })),
      'VERIFICATION_MISMATCH'
    );

    // wrong currency
    gateway.setPlanLookupResult('PLN_mock_mismatch_5', {
      providerPlanId: '11',
      planCode: 'PLN_mock_mismatch_5',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'NGN' as never,
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_mismatch_5' })),
      'VERIFICATION_MISMATCH'
    );

    // wrong interval
    gateway.setPlanLookupResult('PLN_mock_mismatch_6', {
      providerPlanId: '12',
      planCode: 'PLN_mock_mismatch_6',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'annually' as never,
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_mismatch_6' })),
      'VERIFICATION_MISMATCH'
    );

    // wrong name
    gateway.setPlanLookupResult('PLN_mock_mismatch_7', {
      providerPlanId: '13',
      planCode: 'PLN_mock_mismatch_7',
      name: 'Wrong Plan Name',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_mismatch_7' })),
      'VERIFICATION_MISMATCH'
    );

    // wrong code
    gateway.setPlanLookupResult('PLN_mock_mismatch_8', {
      providerPlanId: '14',
      planCode: 'PLN_mock_mismatch_8_different',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_mismatch_8' })),
      'VERIFICATION_MISMATCH'
    );

    // malformed ID in mock
    gateway.setPlanLookupResult('PLN_mock_malformed_9', {
      providerPlanId: 'not-a-number',
      planCode: 'PLN_mock_malformed_9',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_malformed_9' })),
      'INVALID_RESPONSE'
    );

    // malformed code format in mock
    gateway.setPlanLookupResult('PLN_mock_malformed_10', {
      providerPlanId: '15',
      planCode: 'BAD_CODE_FORMAT',
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });
    await assertGatewayError(
      gateway.fetchPlanByCode(fetchInput({ planCode: 'PLN_mock_malformed_10' })),
      'INVALID_RESPONSE'
    );
  });
});

describe('plan-linked transaction initialization', () => {
  const defaultPlan = (overrides: Partial<PlanInitializationOptions> = {}): PlanInitializationOptions => ({
    planCode: 'PLN_test_plan_5000',
    expectedAmountCents: 5_000,
    expectedCurrency: 'USD',
    expectedInterval: 'monthly',
    expectedName: 'Rota Team (10 seats)',
    ...overrides,
  });

  const validPlanData = {
    id: 101,
    plan_code: 'PLN_test_plan_5000',
    name: 'Rota Team (10 seats)',
    amount: 5_000,
    interval: 'monthly',
    currency: 'USD',
  };

  it('performs valid plan-linked initialization in MockPaystackGateway', async () => {
    const gateway = new MockPaystackGateway();
    const createdPlan = await gateway.createPlan({
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });

    const initInput = input({
      amountCents: 5_000,
      plan: {
        planCode: createdPlan.planCode,
        expectedAmountCents: 5_000,
        expectedCurrency: 'USD',
        expectedInterval: 'monthly',
        expectedName: 'Rota Team (10 seats)',
      },
    });

    const initialized = await gateway.initializeTransaction(initInput);
    assert.equal(initialized.reference, initInput.reference);
    assert.ok(initialized.authorizationUrl.includes(encodeURIComponent(initInput.reference)));
    assert.equal(initialized.accessCode, `mock_${initInput.reference}`);

    // Verification also succeeds
    gateway.simulateSuccess(initialized.reference);
    const verified = await gateway.verifyTransaction({
      reference: initialized.reference,
      expectedAmountCents: 5_000,
      expectedCurrency: 'USD',
    });
    assert.equal(verified.status, 'success');
    assert.equal(verified.amountCents, 5_000);
  });

  it('performs valid plan-linked initialization in PaystackGateway verifying plan and passing plan in body', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        if (String(url).includes('/plan/')) {
          return response({
            status: true,
            data: validPlanData,
          });
        }
        return response({
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/auth_plan_123',
            access_code: 'access_plan_123',
            reference: 'rota-team-20261026-001',
          },
        });
      },
    });

    const initInput = input({
      amountCents: 5_000,
      plan: defaultPlan(),
    });

    const initialized = await gateway.initializeTransaction(initInput);

    assert.equal(initialized.reference, initInput.reference);
    assert.equal(initialized.authorizationUrl, 'https://checkout.paystack.com/auth_plan_123');
    assert.equal(initialized.accessCode, 'access_plan_123');

    // First request: GET /plan/:code
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.paystack.co/plan/PLN_test_plan_5000');
    assert.equal(requests[0].init.method, 'GET');

    // Second request: POST /transaction/initialize with plan field
    assert.equal(requests[1].url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(requests[1].init.method, 'POST');
    const body = JSON.parse(String(requests[1].init.body));
    assert.equal(body.email, initInput.customerEmail);
    assert.equal(body.amount, 5_000);
    assert.equal(body.currency, 'USD');
    assert.equal(body.reference, initInput.reference);
    assert.equal(body.plan, 'PLN_test_plan_5000');
  });

  it('preserves ordinary one-off checkout behavior when no plan is provided', async () => {
    // Mock gateway
    const mockGateway = new MockPaystackGateway();
    const mockInit = await mockGateway.initializeTransaction(input());
    assert.equal(mockInit.reference, input().reference);

    // PaystackGateway
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const httpGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return response({
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/auth_oneoff',
            access_code: 'access_oneoff',
            reference: input().reference,
          },
        });
      },
    });

    const httpInit = await httpGateway.initializeTransaction(input());
    assert.equal(httpInit.reference, input().reference);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.paystack.co/transaction/initialize');
    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.plan, undefined);
  });

  it('rejects invalid plan inputs and malformed plan configurations before provider calls', async () => {
    const gateway = new MockPaystackGateway();

    // Malformed plan code
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan({ planCode: 'BAD_CODE' }),
      })),
      'VALIDATION'
    );

    // Non-USD currency in plan
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan({ expectedCurrency: 'NGN' as never }),
      })),
      'VALIDATION'
    );

    // Non-monthly interval in plan
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan({ expectedInterval: 'annually' as never }),
      })),
      'VALIDATION'
    );

    // Empty plan name
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan({ expectedName: '' }),
      })),
      'VALIDATION'
    );

    // Non-object plan
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: 'invalid-string' as never,
      })),
      'VALIDATION'
    );
  });

  it('rejects price and currency mismatches between payment and plan before provider calls', async () => {
    const gateway = new MockPaystackGateway();

    // amountCents differs from plan expectedAmountCents
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 6_000,
        plan: defaultPlan({ expectedAmountCents: 5_000 }),
      })),
      'VALIDATION'
    );

    // currency differs from plan expectedCurrency
    await assertGatewayError(
      gateway.initializeTransaction(input({
        amountCents: 5_000,
        currency: 'NGN',
        plan: defaultPlan({ expectedCurrency: 'USD' }),
      })),
      'VALIDATION'
    );
  });

  it('rejects plan-linked initialization when plan does not exist or provider response mismatches', async () => {
    // 1. Missing plan in MockPaystackGateway
    const mockGateway = new MockPaystackGateway();
    await assertGatewayError(
      mockGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan({ planCode: 'PLN_uncreated_plan' }),
      })),
      'VERIFICATION_MISMATCH'
    );

    // 2. Missing plan (HTTP 404) in PaystackGateway
    let initializeCalls = 0;
    const notFoundGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalls++;
        }
        return response({ status: false, message: 'Plan not found' }, 404);
      },
    });
    await assertGatewayError(
      notFoundGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'VERIFICATION_MISMATCH'
    );
    assert.equal(initializeCalls, 0);

    // 3. Provider plan amount mismatch
    const amountMismatchGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalls++;
        }
        return response({ status: true, data: { ...validPlanData, amount: 4_000 } });
      },
    });
    await assertGatewayError(
      amountMismatchGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'VERIFICATION_MISMATCH'
    );
    assert.equal(initializeCalls, 0);

    // 4. Provider plan name mismatch
    const nameMismatchGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalls++;
        }
        return response({ status: true, data: { ...validPlanData, name: 'Different Plan Name' } });
      },
    });
    await assertGatewayError(
      nameMismatchGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'VERIFICATION_MISMATCH'
    );
    assert.equal(initializeCalls, 0);

    // 5. Malformed provider plan response
    const malformedGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalls++;
        }
        return response({ status: true, data: { ...validPlanData, id: 'not-a-number' } });
      },
    });
    await assertGatewayError(
      malformedGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'INVALID_RESPONSE'
    );
    assert.equal(initializeCalls, 0);
  });

  it('enforces idempotency and rejects conflicting duplicate operations with plans in MockPaystackGateway', async () => {
    const gateway = new MockPaystackGateway();
    await gateway.createPlan({
      name: 'Rota Team (10 seats)',
      amountCents: 5_000,
      interval: 'monthly',
      currency: 'USD',
    });

    const planA = defaultPlan({ planCode: 'PLN_mock_5000_1' });
    const baseInput = input({
      reference: 'rota-dup-test-001',
      idempotencyKey: 'dup-key-001',
      amountCents: 5_000,
      plan: planA,
    });

    // 1. Initial plan-linked initialization succeeds
    const first = await gateway.initializeTransaction(baseInput);

    // 2. Idempotent replay returns same initialization
    const second = await gateway.initializeTransaction(baseInput);
    assert.deepEqual(second, first);

    // 3. Same reference with different plan code rejected
    await assertGatewayError(
      gateway.initializeTransaction({
        ...baseInput,
        plan: defaultPlan({ planCode: 'PLN_mock_5000_different' }),
      }),
      'DUPLICATE_OPERATION'
    );

    // 4. Same reference with different amount rejected
    await assertGatewayError(
      gateway.initializeTransaction({
        ...baseInput,
        amountCents: 7_500,
        plan: defaultPlan({ expectedAmountCents: 7_500 }),
      }),
      'DUPLICATE_OPERATION'
    );

    // 5. Same reference without plan rejected
    await assertGatewayError(
      gateway.initializeTransaction({
        ...baseInput,
        plan: undefined,
      }),
      'DUPLICATE_OPERATION'
    );

    // 6. One-off initialization followed by plan-linked with same reference rejected
    const oneOffInput = input({
      reference: 'rota-oneoff-then-plan-002',
      idempotencyKey: 'dup-key-002',
      amountCents: 5_000,
    });
    await gateway.initializeTransaction(oneOffInput);
    await assertGatewayError(
      gateway.initializeTransaction({
        ...oneOffInput,
        plan: planA,
      }),
      'DUPLICATE_OPERATION'
    );
  });

  it('handles provider uncertainty during plan lookup and initialization safely', async () => {
    // 1. Plan lookup timeout in PaystackGateway
    let initializeCalled = false;
    const lookupTimeoutGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      timeoutMs: 5,
      fetchImpl: (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalled = true;
        }
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 10);
        });
      },
    });
    await assertGatewayError(
      lookupTimeoutGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'TIMEOUT'
    );
    assert.equal(initializeCalled, false);

    // 2. Plan lookup HTTP 502 Bad Gateway
    const lookup502Gateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      fetchImpl: async (url) => {
        if (String(url).includes('/transaction/initialize')) {
          initializeCalled = true;
        }
        return response({ status: false, message: 'Bad Gateway' }, 502);
      },
    });
    await assertGatewayError(
      lookup502Gateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'HTTP'
    );
    assert.equal(initializeCalled, false);

    // 3. Transaction initialize timeout (after plan lookup succeeds)
    const initTimeoutGateway = new PaystackGateway({
      secretKey: 'sk_test_only-for-tests',
      timeoutMs: 5,
      fetchImpl: (url) => {
        if (String(url).includes('/plan/')) {
          return Promise.resolve(response({ status: true, data: validPlanData }));
        }
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 10);
        });
      },
    });
    await assertGatewayError(
      initTimeoutGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'TIMEOUT'
    );

    // 4. Provider uncertainty during plan lookup in MockPaystackGateway
    const mockGateway = new MockPaystackGateway();
    mockGateway.setPlanLookupResult('PLN_test_plan_5000', new PaymentGatewayError('TIMEOUT', 'Mock plan lookup timeout'));
    await assertGatewayError(
      mockGateway.initializeTransaction(input({
        amountCents: 5_000,
        plan: defaultPlan(),
      })),
      'TIMEOUT'
    );
  });
});
