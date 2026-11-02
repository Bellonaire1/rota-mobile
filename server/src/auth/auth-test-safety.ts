export const LIVE_DEMO_HOST = 'ep-falling-pine-za5gn3mb.c-2.eu-west-2.aws.neon.tech';
export const PERSISTENT_TEST_HOST = 'ep-proud-shadow-za95zphb.c-2.eu-west-2.aws.neon.tech';

/**
 * Normalizes a database hostname to its base endpoint identity by removing
 * port specifications and any Neon PgBouncer '-pooler' suffix.
 */
export const extractEndpointIdentity = (rawHost: string | undefined): string => {
  if (!rawHost) return '';
  const withoutPort = rawHost.split(':')[0].trim().toLowerCase();
  return withoutPort.replace(/-pooler(?=\.|$)/, '');
};

const PROTECTED_IDENTITIES = new Set<string>([
  extractEndpointIdentity(LIVE_DEMO_HOST),
  extractEndpointIdentity(PERSISTENT_TEST_HOST),
]);

/**
 * Checks whether a database connection URL contains query parameters that could
 * override the parsed hostname and redirect the connection socket elsewhere.
 */
export const hasHostOverrideParam = (url: URL): boolean => {
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === 'host' || normalizedKey === 'hostaddr') {
      return true;
    }
  }
  return /(?:^|[?&;])(host|hostaddr)(?:=|[&;]|$)/i.test(url.search);
};

/**
 * Evaluates whether the connection configuration satisfies required safety invariants
 * and points away from protected databases before running authentication integration tests.
 *
 * Note: This guard provides configuration protection against connecting to known live or
 * persistent databases. It does not independently prove that the target database is disposable;
 * actual database disposability requires a separate, independently verified Neon test environment.
 *
 * Returns undefined if configuration safety checks pass.
 * Returns a descriptive skip/rejection reason string if any invariant is violated.
 */
export const authIntegrationSkipReason = (
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  // Invariant 1: Explicit disposable opt-in required
  if (env.AUTH_TEST_DATABASE !== 'disposable') {
    return 'authentication integration tests require AUTH_TEST_DATABASE=disposable';
  }

  // Invariant 2: Explicitly declared approved test host required
  const expectedHost = env.AUTH_TEST_DATABASE_HOST?.trim();
  if (!expectedHost) {
    return 'authentication integration tests require AUTH_TEST_DATABASE_HOST';
  }

  const expectedIdentity = extractEndpointIdentity(expectedHost);

  // Invariant 5: Deny declared host if it targets a known protected database
  if (PROTECTED_IDENTITIES.has(expectedIdentity)) {
    return expectedIdentity === extractEndpointIdentity(LIVE_DEMO_HOST)
      ? 'authentication integration tests refuse the live demonstration database'
      : 'authentication integration tests refuse the persistent rota-shift-testing database';
  }

  // Invariant 3: Parse and validate both DATABASE_URL and DIRECT_URL
  const dbUrlStr = env.DATABASE_URL?.trim();
  const directUrlStr = env.DIRECT_URL?.trim();

  if (!dbUrlStr || !directUrlStr) {
    return 'authentication integration tests require valid PostgreSQL DATABASE_URL and DIRECT_URL';
  }

  let dbUrl: URL;
  let directUrl: URL;
  try {
    dbUrl = new URL(dbUrlStr);
    directUrl = new URL(directUrlStr);
  } catch {
    return 'authentication integration tests require valid PostgreSQL DATABASE_URL and DIRECT_URL';
  }

  // Invariant 6: Must use PostgreSQL protocol
  const validProtocols = ['postgres:', 'postgresql:'];
  if (!validProtocols.includes(dbUrl.protocol) || !validProtocols.includes(directUrl.protocol)) {
    return 'authentication integration tests require postgres: or postgresql: protocol';
  }

  // Invariant 1 (Hardening): Refuse connection strings with host-override query parameters (host, hostaddr)
  if (hasHostOverrideParam(dbUrl) || hasHostOverrideParam(directUrl)) {
    return 'authentication integration tests refuse database connection URLs with host-override query parameters';
  }

  const dbIdentity = extractEndpointIdentity(dbUrl.hostname);
  const directIdentity = extractEndpointIdentity(directUrl.hostname);

  // Invariant 5 (Defense-in-depth): Deny if target connection points to protected database
  if (PROTECTED_IDENTITIES.has(dbIdentity) || PROTECTED_IDENTITIES.has(directIdentity)) {
    return dbIdentity === extractEndpointIdentity(LIVE_DEMO_HOST) ||
      directIdentity === extractEndpointIdentity(LIVE_DEMO_HOST)
      ? 'authentication integration tests refuse the live demonstration database'
      : 'authentication integration tests refuse the persistent rota-shift-testing database';
  }

  // Invariant 4: Support Neon pooled/direct hostname pairs resolving to same identity
  if (dbIdentity !== directIdentity) {
    return 'authentication integration tests require DATABASE_URL and DIRECT_URL to resolve to the same test endpoint identity';
  }

  if (dbIdentity !== expectedIdentity) {
    return 'authentication integration tests require DATABASE_URL and DIRECT_URL to match the declared test host';
  }

  // DIRECT_URL must be a direct (non-pooler) endpoint for reliable admin/DDL execution
  if (directUrl.hostname.toLowerCase().includes('-pooler')) {
    return 'authentication integration tests require DIRECT_URL to be a direct (non-pooler) endpoint';
  }

  // Invariant 6: Database names must match and cannot be empty or root
  const dbName = dbUrl.pathname.replace(/^\//, '');
  const directDbName = directUrl.pathname.replace(/^\//, '');

  if (!dbName || !directDbName || dbName !== directDbName) {
    return 'authentication integration tests require matching non-empty database names';
  }

  return undefined;
};
