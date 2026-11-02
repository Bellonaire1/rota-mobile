import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authIntegrationSkipReason,
  extractEndpointIdentity,
  hasHostOverrideParam,
  LIVE_DEMO_HOST,
  PERSISTENT_TEST_HOST,
} from './auth-test-safety';

describe('auth integration test safety guard', () => {
  const SYNTHETIC_DISPOSABLE_HOST = 'ep-synthetic-disposable-8492.c-2.eu-west-2.aws.neon.tech';
  const SYNTHETIC_DISPOSABLE_POOLED = 'ep-synthetic-disposable-8492-pooler.c-2.eu-west-2.aws.neon.tech';

  it('1. rejects when AUTH_TEST_DATABASE is missing or not disposable (no opt-in)', () => {
    assert.match(
      authIntegrationSkipReason({}) ?? '',
      /require AUTH_TEST_DATABASE=disposable/
    );
    assert.match(
      authIntegrationSkipReason({ AUTH_TEST_DATABASE: 'true' }) ?? '',
      /require AUTH_TEST_DATABASE=disposable/
    );
    assert.match(
      authIntegrationSkipReason({ AUTH_TEST_DATABASE: 'test' }) ?? '',
      /require AUTH_TEST_DATABASE=disposable/
    );
  });

  it('2. rejects when AUTH_TEST_DATABASE_HOST is missing or empty', () => {
    assert.match(
      authIntegrationSkipReason({
        AUTH_TEST_DATABASE: 'disposable',
      }) ?? '',
      /require AUTH_TEST_DATABASE_HOST/
    );
    assert.match(
      authIntegrationSkipReason({
        AUTH_TEST_DATABASE: 'disposable',
        AUTH_TEST_DATABASE_HOST: '   ',
      }) ?? '',
      /require AUTH_TEST_DATABASE_HOST/
    );
  });

  it('3. rejects when DATABASE_URL or DIRECT_URL is missing, malformed, or non-postgresql', () => {
    // Missing URLs
    assert.match(
      authIntegrationSkipReason({
        AUTH_TEST_DATABASE: 'disposable',
        AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      }) ?? '',
      /require valid PostgreSQL DATABASE_URL and DIRECT_URL/
    );

    // Malformed URLs
    assert.match(
      authIntegrationSkipReason({
        AUTH_TEST_DATABASE: 'disposable',
        AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
        DATABASE_URL: 'not-a-valid-url',
        DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
      }) ?? '',
      /require valid PostgreSQL DATABASE_URL and DIRECT_URL/
    );

    // Non-PostgreSQL protocol
    assert.match(
      authIntegrationSkipReason({
        AUTH_TEST_DATABASE: 'disposable',
        AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
        DATABASE_URL: `mysql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
        DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
      }) ?? '',
      /require postgres: or postgresql: protocol/
    );
  });

  it('4. rejects live demonstration database endpoint', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${LIVE_DEMO_HOST}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${LIVE_DEMO_HOST}/neondb`,
    });
    assert.match(reason ?? '', /refuse the live demonstration database/);
  });

  it('5. rejects persistent rota-shift-testing database endpoint', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${PERSISTENT_TEST_HOST}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${PERSISTENT_TEST_HOST}/neondb`,
    });
    assert.match(reason ?? '', /refuse the persistent rota-shift-testing database/);
  });

  it('6. refuses live demo or persistent test hosts even if falsely marked as disposable', () => {
    // Declaring live demo host as AUTH_TEST_DATABASE_HOST
    const demoAttempt = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: LIVE_DEMO_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${LIVE_DEMO_HOST}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${LIVE_DEMO_HOST}/neondb`,
    });
    assert.match(demoAttempt ?? '', /refuse the live demonstration database/);

    // Declaring persistent test host as AUTH_TEST_DATABASE_HOST
    const persistentAttempt = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: PERSISTENT_TEST_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${PERSISTENT_TEST_HOST}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${PERSISTENT_TEST_HOST}/neondb`,
    });
    assert.match(persistentAttempt ?? '', /refuse the persistent rota-shift-testing database/);
  });

  it('7. rejects pooled/direct host mismatch', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
      DIRECT_URL: 'postgresql://synth_user:synth_pass@ep-completely-different.c-2.eu-west-2.aws.neon.tech/neondb',
    });
    assert.match(
      reason ?? '',
      /require DATABASE_URL and DIRECT_URL to resolve to the same test endpoint identity/
    );
  });

  it('8. rejects when DIRECT_URL is mistakenly configured with a pooler endpoint', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
    });
    assert.match(reason ?? '', /require DIRECT_URL to be a direct \(non-pooler\) endpoint/);
  });

  it('9. rejects database name mismatch or empty database name', () => {
    const mismatch = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/test_db_1`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/test_db_2`,
    });
    assert.match(mismatch ?? '', /require matching non-empty database names/);

    const emptyName = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/`,
    });
    assert.match(emptyName ?? '', /require matching non-empty database names/);
  });

  it('10. rejects host-override query parameter on DATABASE_URL', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb?host=malicious-host.com`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
    });
    assert.match(
      reason ?? '',
      /refuse database connection URLs with host-override query parameters/
    );
  });

  it('11. rejects host-override query parameter on DIRECT_URL', () => {
    const reason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb?host=malicious-host.com`,
    });
    assert.match(
      reason ?? '',
      /refuse database connection URLs with host-override query parameters/
    );
  });

  it('12. rejects hostaddr query parameter on either connection URL', () => {
    const dbReason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb?hostaddr=127.0.0.1`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
    });
    assert.match(
      dbReason ?? '',
      /refuse database connection URLs with host-override query parameters/
    );

    const directReason = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb?hostaddr=10.0.0.1`,
    });
    assert.match(
      directReason ?? '',
      /refuse database connection URLs with host-override query parameters/
    );
  });

  it('13. rejects case variations of host-override query parameters (e.g. HOST, HostAddr)', () => {
    const upperHost = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb?HOST=malicious-redirect.com`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb`,
    });
    assert.match(
      upperHost ?? '',
      /refuse database connection URLs with host-override query parameters/
    );

    const mixedHostAddr = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_POOLED}/neondb`,
      DIRECT_URL: `postgresql://synth_user:synth_pass@${SYNTHETIC_DISPOSABLE_HOST}/neondb?HostAddr=192.168.1.1`,
    });
    assert.match(
      mixedHostAddr ?? '',
      /refuse database connection URLs with host-override query parameters/
    );
  });

  it('14. accepts legitimate connection parameters such as sslmode=require and pgbouncer=true', () => {
    const result = authIntegrationSkipReason({
      AUTH_TEST_DATABASE: 'disposable',
      AUTH_TEST_DATABASE_HOST: SYNTHETIC_DISPOSABLE_HOST,
      DATABASE_URL: `postgresql://synthetic_user:synthetic_password@${SYNTHETIC_DISPOSABLE_POOLED}:5432/neondb?sslmode=require&pgbouncer=true`,
      DIRECT_URL: `postgresql://synthetic_user:synthetic_password@${SYNTHETIC_DISPOSABLE_HOST}:5432/neondb?sslmode=require`,
    });
    assert.equal(result, undefined);
  });

  it('15. extractEndpointIdentity normalizes pooler suffixes, ports, and casing', () => {
    assert.equal(
      extractEndpointIdentity('ep-cool-breeze-123456-pooler.c-2.eu-west-2.aws.neon.tech:5432'),
      'ep-cool-breeze-123456.c-2.eu-west-2.aws.neon.tech'
    );
    assert.equal(
      extractEndpointIdentity('EP-COOL-BREEZE-123456.C-2.EU-WEST-2.AWS.NEON.TECH'),
      'ep-cool-breeze-123456.c-2.eu-west-2.aws.neon.tech'
    );
  });

  it('16. hasHostOverrideParam detects host and hostaddr regardless of case or position', () => {
    assert.equal(
      hasHostOverrideParam(new URL('postgresql://user:pass@ep-test.neon.tech/neondb?sslmode=require')),
      false
    );
    assert.equal(
      hasHostOverrideParam(new URL('postgresql://user:pass@ep-test.neon.tech/neondb?host=evil.com')),
      true
    );
    assert.equal(
      hasHostOverrideParam(new URL('postgresql://user:pass@ep-test.neon.tech/neondb?HOST=evil.com')),
      true
    );
    assert.equal(
      hasHostOverrideParam(new URL('postgresql://user:pass@ep-test.neon.tech/neondb?hostaddr=127.0.0.1')),
      true
    );
    assert.equal(
      hasHostOverrideParam(new URL('postgresql://user:pass@ep-test.neon.tech/neondb?HostAddr=127.0.0.1')),
      true
    );
  });

  it('17. default invocation checks process.env deterministically and restores environment', () => {
    const previousAuthTestDb = process.env.AUTH_TEST_DATABASE;
    const previousAuthTestHost = process.env.AUTH_TEST_DATABASE_HOST;
    try {
      delete process.env.AUTH_TEST_DATABASE;
      delete process.env.AUTH_TEST_DATABASE_HOST;
      const defaultReason = authIntegrationSkipReason();
      assert.ok(defaultReason !== undefined);
      assert.match(defaultReason, /require AUTH_TEST_DATABASE=disposable/);
    } finally {
      if (previousAuthTestDb === undefined) {
        delete process.env.AUTH_TEST_DATABASE;
      } else {
        process.env.AUTH_TEST_DATABASE = previousAuthTestDb;
      }
      if (previousAuthTestHost === undefined) {
        delete process.env.AUTH_TEST_DATABASE_HOST;
      } else {
        process.env.AUTH_TEST_DATABASE_HOST = previousAuthTestHost;
      }
    }
  });
});
