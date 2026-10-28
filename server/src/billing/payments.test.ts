import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MockPaystackGateway,
  PaystackGateway,
  PaymentGatewayError,
  type InitializePaymentInput,
} from './payments';

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
