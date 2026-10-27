import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file if present
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PAYSTACK_MODE: z.literal('test').default('test'),
  PAYSTACK_TEST_SECRET_KEY: z.string().min(1).optional(),
  PAYSTACK_API_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_WORKER_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30_000),
  WEBHOOK_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WEBHOOK_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  WEBHOOK_WORKER_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_WORKER_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
  WEBHOOK_WORKER_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment configuration:', parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
