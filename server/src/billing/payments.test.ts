import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MockPaystackGateway,
  PaystackGateway,
  PaymentGatewayError,
  type CreatePlanInput,
  type InitializePaymentInput,
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
