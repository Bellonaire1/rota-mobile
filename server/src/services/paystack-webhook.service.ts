import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BillingWebhookEventStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../database/prisma';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';

const PAYSTACK_PROVIDER = 'paystack';
const PAYSTACK_WEBHOOK_MAX_BODY_BYTES = 100 * 1024;

type PaystackWebhookPayload = {
  event: string;
  data: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parsePayload = (rawBody: Buffer): { payload: Prisma.InputJsonValue; webhook: PaystackWebhookPayload } => {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'Malformed Paystack webhook JSON');
  }
  if (!isRecord(value)
    || typeof value.event !== 'string'
    || value.event.length === 0
    || value.event.length > 128
    || !isRecord(value.data)) {
    throw new AppError(400, 'Invalid Paystack webhook payload');
  }
  return {
    payload: value as Prisma.InputJsonValue,
    webhook: { event: value.event, data: value.data },
  };
};

const assertSignature = (rawBody: Buffer, signature: string | undefined): void => {
  if (env.PAYSTACK_MODE !== 'test' || !env.PAYSTACK_TEST_SECRET_KEY) {
    throw new AppError(503, 'Paystack webhook verification is not configured');
  }
  if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) {
    throw new AppError(401, 'Invalid Paystack webhook signature');
  }
  const expected = createHmac('sha512', env.PAYSTACK_TEST_SECRET_KEY).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AppError(401, 'Invalid Paystack webhook signature');
  }
};

export class PaystackWebhookService {
  constructor(private readonly database: typeof defaultPrisma = defaultPrisma) {}

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!rawBody || rawBody.length === 0 || rawBody.length > PAYSTACK_WEBHOOK_MAX_BODY_BYTES) {
      throw new AppError(400, 'A valid raw Paystack webhook body is required');
    }
    assertSignature(rawBody, signature);
    const { payload, webhook } = parsePayload(rawBody);
    // Hashing the exact serialization makes delivery deduplication distinct from
    // future financial idempotency, which must use provider transaction identity.
    const providerEventId = `${webhook.event}:${createHash('sha256').update(rawBody).digest('hex')}`;

    try {
      await this.database.billingWebhookEvent.create({
        data: {
          provider: PAYSTACK_PROVIDER,
          providerEventId,
          eventType: webhook.event,
          payload: payload as Prisma.InputJsonValue,
          signatureVerifiedAt: new Date(),
          status: BillingWebhookEventStatus.RECEIVED,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }
}

export const paystackWebhookService = new PaystackWebhookService();
