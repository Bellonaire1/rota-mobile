import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { authIntegrationSkipReason } from './auth/auth-test-safety';

// 1. Locate and load ONLY server/.env.auth-test.local
const envPath = path.resolve(__dirname, '../.env.auth-test.local');
if (!fs.existsSync(envPath)) {
  console.error('[SAFE LAUNCHER ERROR] Missing .env.auth-test.local at:', envPath);
  process.exit(1);
}

const fileContent = fs.readFileSync(envPath, 'utf8');
const testEnv = dotenv.parse(fileContent);

// Populate process.env explicitly
for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] = value;
}

// Neutralize subsequent dotenv.config() calls so server/.env is never read
dotenv.config = () => ({ parsed: testEnv });

// 2. Verify NODE_ENV=test and AUTH_TEST_DATABASE=disposable
if (process.env.NODE_ENV !== 'test') {
  console.error(
    `[SAFE LAUNCHER ERROR] Refusing startup: NODE_ENV must be "test" (got "${process.env.NODE_ENV}")`
  );
  process.exit(1);
}

if (process.env.AUTH_TEST_DATABASE !== 'disposable') {
  console.error(
    `[SAFE LAUNCHER ERROR] Refusing startup: AUTH_TEST_DATABASE must be "disposable" (got "${process.env.AUTH_TEST_DATABASE}")`
  );
  process.exit(1);
}

// 3. Invoke authIntegrationSkipReason()
const skipReason = authIntegrationSkipReason(process.env);
if (skipReason) {
  console.error(`[SAFE LAUNCHER ERROR] Safety guard violation: ${skipReason}`);
  process.exit(1);
}

// 4. Invariant checks
const APPROVED_HOST = 'ep-small-dawn-za43lp0z.c-2.eu-west-2.aws.neon.tech';
const APPROVED_DB = 'neondb';

const dbUrl = new URL(process.env.DATABASE_URL!);
const directUrl = new URL(process.env.DIRECT_URL!);

const cleanHost = (h: string) =>
  h.split(':')[0].toLowerCase().replace(/-pooler(?=\.|$)/, '');

if (
  cleanHost(dbUrl.hostname) !== APPROVED_HOST ||
  cleanHost(directUrl.hostname) !== APPROVED_HOST
) {
  console.error(
    '[SAFE LAUNCHER ERROR] Database host mismatch! Refusing connection to non-approved host.'
  );
  process.exit(1);
}

const dbName = dbUrl.pathname.replace(/^\//, '');
if (dbName !== APPROVED_DB) {
  console.error(
    `[SAFE LAUNCHER ERROR] Database name must be "${APPROVED_DB}" (got "${dbName}"). Refusing connection.`
  );
  process.exit(1);
}

// Enforce port 5000
process.env.PORT = '5000';

console.log('====================================================');
console.log('  ROTA SAFE DISPOSABLE SERVER LAUNCHER');
console.log('====================================================');
console.log(`[Safety Guard] Target Host:      ${APPROVED_HOST}`);
console.log(`[Safety Guard] Target DB:        ${APPROVED_DB}`);
console.log(`[Safety Guard] Target Project:   calm-bird-93784411 (disposable)`);
console.log(`[Safety Guard] Auth Mode:        AUTH_TEST_DATABASE=disposable`);
console.log(`[Safety Guard] Node Environment: ${process.env.NODE_ENV}`);
console.log(`[Safety Guard] Listening Port:   ${process.env.PORT}`);
console.log('[Safety Guard] Invariants verified. Starting Express server...');
console.log('====================================================\n');

// 5. Start the actual Express server
import('./index');

