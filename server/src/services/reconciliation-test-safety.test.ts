import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconciliationIntegrationSkipReason } from './reconciliation-test-safety';

describe('reconciliation integration safety guard', () => {
  it('refuses the persistent rota-shift-testing host', () => {
    const previous = {
      mode: process.env.RECONCILIATION_TEST_DATABASE,
      host: process.env.RECONCILIATION_TEST_DATABASE_HOST,
      database: process.env.DATABASE_URL,
      direct: process.env.DIRECT_URL,
    };
    process.env.RECONCILIATION_TEST_DATABASE = 'disposable';
    process.env.RECONCILIATION_TEST_DATABASE_HOST = 'ep-proud-shadow-za95zphb.c-2.eu-west-2.aws.neon.tech';
    process.env.DATABASE_URL = 'postgresql://test@ep-proud-shadow-za95zphb.c-2.eu-west-2.aws.neon.tech/neondb';
    process.env.DIRECT_URL = process.env.DATABASE_URL;
    assert.match(reconciliationIntegrationSkipReason() ?? '', /persistent rota-shift-testing/);
    for (const [key, value] of Object.entries({
      RECONCILIATION_TEST_DATABASE: previous.mode,
      RECONCILIATION_TEST_DATABASE_HOST: previous.host,
      DATABASE_URL: previous.database,
      DIRECT_URL: previous.direct,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires explicit disposable-host declaration', () => {
    const previous = process.env.RECONCILIATION_TEST_DATABASE;
    delete process.env.RECONCILIATION_TEST_DATABASE;
    assert.match(reconciliationIntegrationSkipReason() ?? '', /require RECONCILIATION_TEST_DATABASE=disposable/);
    if (previous === undefined) delete process.env.RECONCILIATION_TEST_DATABASE;
    else process.env.RECONCILIATION_TEST_DATABASE = previous;
  });
});
