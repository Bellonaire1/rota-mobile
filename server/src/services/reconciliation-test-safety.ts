const PERSISTENT_TEST_HOST = 'ep-proud-shadow-za95zphb.c-2.eu-west-2.aws.neon.tech';

export const reconciliationIntegrationSkipReason = (): string | undefined => {
  if (process.env.RECONCILIATION_TEST_DATABASE !== 'disposable') {
    return 'financial reconciliation integration tests require RECONCILIATION_TEST_DATABASE=disposable';
  }
  const expectedHost = process.env.RECONCILIATION_TEST_DATABASE_HOST;
  if (!expectedHost) return 'financial reconciliation integration tests require RECONCILIATION_TEST_DATABASE_HOST';

  let databaseUrl: URL;
  let directUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    directUrl = new URL(process.env.DIRECT_URL ?? '');
  } catch {
    return 'financial reconciliation integration tests require valid DATABASE_URL and DIRECT_URL';
  }

  if (databaseUrl.host !== expectedHost || directUrl.host !== expectedHost) {
    return 'financial reconciliation integration tests require DATABASE_URL and DIRECT_URL to match the declared disposable host';
  }
  if (databaseUrl.host === PERSISTENT_TEST_HOST || directUrl.host === PERSISTENT_TEST_HOST) {
    return 'financial reconciliation integration tests refuse the persistent rota-shift-testing database';
  }
  if (databaseUrl.pathname !== '/neondb' || directUrl.pathname !== '/neondb') {
    return 'financial reconciliation integration tests require the neondb database';
  }
  return undefined;
};
