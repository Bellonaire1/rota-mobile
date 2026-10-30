import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { billingController } from '../controllers/billing.controller';
import { env } from '../config/env';

describe('Demo Mode Fail-Closed Financial Boundary', () => {
  it('blocks billing checkout with HTTP 403 when DEMO_MODE is active', async () => {
    // Save original state and force demo mode active
    const originalDemoMode = (env as any).DEMO_MODE;
    (env as any).DEMO_MODE = true;

    try {
      let statusCode = 0;
      let responseBody: any = null;

      const mockReq: any = {
        params: { teamId: 'test-team-id' },
        auth: { userId: 'test-user-id' },
        body: { planCode: 'TEAM', staffSeatCount: 5 },
        header: () => 'test-idempotency-key',
      };

      const mockRes: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
      };

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      await billingController.checkout(mockReq, mockRes, mockNext);

      assert.equal(statusCode, 403);
      assert.equal(responseBody?.error, 'Forbidden');
      assert.match(responseBody?.message, /disabled in the demonstration environment/i);
      assert.equal(nextCalled, false);
    } finally {
      (env as any).DEMO_MODE = originalDemoMode;
    }
  });

  it('blocks Paystack webhook ingestion with HTTP 403 when DEMO_MODE is active', async () => {
    const originalDemoMode = (env as any).DEMO_MODE;
    (env as any).DEMO_MODE = true;

    try {
      let statusCode = 0;
      let responseBody: any = null;

      const mockReq: any = {
        rawBody: Buffer.from(JSON.stringify({ event: 'charge.success' })),
        header: () => 'mock-signature',
      };

      const mockRes: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
      };

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      await billingController.paystackWebhook(mockReq, mockRes, mockNext);

      assert.equal(statusCode, 403);
      assert.equal(responseBody?.error, 'Forbidden');
      assert.match(responseBody?.message, /disabled in the demonstration environment/i);
      assert.equal(nextCalled, false);
    } finally {
      (env as any).DEMO_MODE = originalDemoMode;
    }
  });
});
