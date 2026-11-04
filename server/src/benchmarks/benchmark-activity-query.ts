import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';
import { BENCHMARK_TEAM_NAME, TOTAL_RECORDS_TARGET } from './seed-activity-fixtures';

// 1. Safety Checks
const envPath = path.resolve(__dirname, '../../.env.auth-test.local');
if (!fs.existsSync(envPath)) {
  console.error('[SAFETY ERROR] Missing .env.auth-test.local at:', envPath);
  process.exit(1);
}

const fileContent = fs.readFileSync(envPath, 'utf8');
const testEnv = dotenv.parse(fileContent);
for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] = value;
}

if (process.env.NODE_ENV !== 'test') {
  console.error('[SAFETY ERROR] NODE_ENV must be "test"');
  process.exit(1);
}
if (process.env.AUTH_TEST_DATABASE !== 'disposable') {
  console.error('[SAFETY ERROR] AUTH_TEST_DATABASE must be "disposable"');
  process.exit(1);
}

const skipReason = authIntegrationSkipReason(process.env);
if (skipReason) {
  console.error('[SAFETY ERROR] Safety guard violation:', skipReason);
  process.exit(1);
}

const APPROVED_HOST = 'ep-small-dawn-za43lp0z.c-2.eu-west-2.aws.neon.tech';
const APPROVED_DB = 'neondb';

const cleanHost = (h: string) => (h || '').split(':')[0].toLowerCase().replace(/-pooler(?=\.|$)/, '');
const dbUrl = new URL(process.env.DATABASE_URL!);
const directUrl = new URL(process.env.DIRECT_URL!);

if (cleanHost(dbUrl.hostname) !== APPROVED_HOST || cleanHost(directUrl.hostname) !== APPROVED_HOST) {
  console.error('[SAFETY ERROR] Host mismatch! Must target disposable host.');
  process.exit(1);
}
if (dbUrl.pathname.replace(/^\//, '') !== APPROVED_DB) {
  console.error(`[SAFETY ERROR] Database name mismatch! Must target neondb.`);
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

export interface QueryMetric {
  queryName: string;
  paginationType: 'keyset' | 'offset';
  paginationDepth: string;
  hasIndex: boolean;
  planningTimeMs: number;
  executionTimeMs: number;
  planNode: string;
  actualRows: number;
  sharedHitBlocks: number;
  rawPlanText?: string;
}

async function explainAnalyze(sql: string): Promise<{
  plan: any;
  planningTimeMs: number;
  executionTimeMs: number;
  planNode: string;
  actualRows: number;
  sharedHitBlocks: number;
  rawPlanText: string;
}> {
  const [jsonRes, textRes] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`),
    prisma.$queryRawUnsafe<any[]>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`),
  ]);
  const planObj = jsonRes[0]['QUERY PLAN'][0];
  const rootPlan = planObj['Plan'];
  const rawPlanText = textRes.map((r: any) => r['QUERY PLAN']).join('\n');

  return {
    plan: planObj,
    planningTimeMs: planObj['Planning Time'],
    executionTimeMs: planObj['Execution Time'],
    planNode: rootPlan['Node Type'],
    actualRows: rootPlan['Actual Rows'],
    sharedHitBlocks: rootPlan['Shared Hit Blocks'] || 0,
    rawPlanText,
  };
}

export async function runBenchmarks(): Promise<{
  totalRecords: number;
  metrics: QueryMetric[];
}> {
  console.log('========================================================');
  console.log('  ROTA ACTIVITY FEED QUERY BENCHMARKS (EXPLAIN ANALYZE)');
  console.log('========================================================');
  console.log(`[Safety Guard] Target Host:    ${APPROVED_HOST}`);
  console.log(`[Safety Guard] Target DB:      ${APPROVED_DB}`);
  console.log(`[Safety Guard] Target Project: calm-bird-93784411 (disposable)`);
  console.log('========================================================\n');

  const team = await prisma.team.findFirstOrThrow({
    where: { name: BENCHMARK_TEAM_NAME },
  });

  const totalRecords = await prisma.activityEvent.count({ where: { teamId: team.id } });
  console.log(`[Setup] Benchmark Team ID: ${team.id}`);
  console.log(`[Setup] Total Activity Records in Team: ${totalRecords}\n`);

  if (totalRecords < TOTAL_RECORDS_TARGET) {
    throw new Error(`Insufficient records for benchmarking (${totalRecords} < ${TOTAL_RECORDS_TARGET})`);
  }

  // Ensure table statistics are fully up-to-date
  await prisma.$executeRawUnsafe(`ANALYZE "ActivityEvent"`);

  // Fetch reference cursors for deep pagination
  // 1. Shallow (offset 0)
  // 2. Mid (offset 5,000)
  const midEvents = await prisma.activityEvent.findMany({
    where: { teamId: team.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: 5000,
    take: 1,
  });
  const midCursor = midEvents[0];

  // 3. Deep (offset 9,000)
  const deepEvents = await prisma.activityEvent.findMany({
    where: { teamId: team.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: 9000,
    take: 1,
  });
  const deepCursor = deepEvents[0];

  const metrics: QueryMetric[] = [];

  // Helper to run query suite for a specific index state
  async function runQuerySuite(hasIndex: boolean) {
    const label = hasIndex ? 'WITH COMPOSITE INDEX' : 'WITHOUT COMPOSITE INDEX';
    console.log(`--- Running Benchmark Suite: ${label} ---`);

    // 1. Shallow Offset (Offset 0, Limit 20)
    const sqlOffsetShallow = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20 OFFSET 0;
    `;
    const resOffsetShallow = await explainAnalyze(sqlOffsetShallow);
    metrics.push({
      queryName: 'Offset Page 1 (offset 0, limit 20)',
      paginationType: 'offset',
      paginationDepth: 'Page 1 (offset 0)',
      hasIndex,
      planningTimeMs: resOffsetShallow.planningTimeMs,
      executionTimeMs: resOffsetShallow.executionTimeMs,
      planNode: resOffsetShallow.planNode,
      actualRows: resOffsetShallow.actualRows,
      sharedHitBlocks: resOffsetShallow.sharedHitBlocks,
      rawPlanText: resOffsetShallow.rawPlanText,
    });
    console.log(`  Offset Shallow (0):        ${resOffsetShallow.executionTimeMs.toFixed(3)} ms [${resOffsetShallow.planNode}]`);

    // 2. Shallow Keyset (Page 1, Limit 20)
    const sqlKeysetShallow = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20;
    `;
    const resKeysetShallow = await explainAnalyze(sqlKeysetShallow);
    metrics.push({
      queryName: 'Keyset Page 1 (limit 20)',
      paginationType: 'keyset',
      paginationDepth: 'Page 1 (initial)',
      hasIndex,
      planningTimeMs: resKeysetShallow.planningTimeMs,
      executionTimeMs: resKeysetShallow.executionTimeMs,
      planNode: resKeysetShallow.planNode,
      actualRows: resKeysetShallow.actualRows,
      sharedHitBlocks: resKeysetShallow.sharedHitBlocks,
      rawPlanText: resKeysetShallow.rawPlanText,
    });
    console.log(`  Keyset Shallow (Initial):  ${resKeysetShallow.executionTimeMs.toFixed(3)} ms [${resKeysetShallow.planNode}]`);

    // 3. Mid Offset (Offset 5,000, Limit 20)
    const sqlOffsetMid = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20 OFFSET 5000;
    `;
    const resOffsetMid = await explainAnalyze(sqlOffsetMid);
    metrics.push({
      queryName: 'Offset Mid (offset 5000, limit 20)',
      paginationType: 'offset',
      paginationDepth: 'Offset 5,000',
      hasIndex,
      planningTimeMs: resOffsetMid.planningTimeMs,
      executionTimeMs: resOffsetMid.executionTimeMs,
      planNode: resOffsetMid.planNode,
      actualRows: resOffsetMid.actualRows,
      sharedHitBlocks: resOffsetMid.sharedHitBlocks,
      rawPlanText: resOffsetMid.rawPlanText,
    });
    console.log(`  Offset Mid (5,000):        ${resOffsetMid.executionTimeMs.toFixed(3)} ms [${resOffsetMid.planNode}]`);

    // 4. Mid Keyset (Offset 5,000 equivalent cursor)
    const midCreatedAtIso = midCursor.createdAt.toISOString();
    const sqlKeysetMid = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
        AND (
          "createdAt" < '${midCreatedAtIso}'
          OR ("createdAt" = '${midCreatedAtIso}' AND "id" < '${midCursor.id}')
        )
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20;
    `;
    const resKeysetMid = await explainAnalyze(sqlKeysetMid);
    metrics.push({
      queryName: 'Keyset Mid (offset 5000 equivalent, limit 20)',
      paginationType: 'keyset',
      paginationDepth: 'Offset 5,000 equivalent',
      hasIndex,
      planningTimeMs: resKeysetMid.planningTimeMs,
      executionTimeMs: resKeysetMid.executionTimeMs,
      planNode: resKeysetMid.planNode,
      actualRows: resKeysetMid.actualRows,
      sharedHitBlocks: resKeysetMid.sharedHitBlocks,
      rawPlanText: resKeysetMid.rawPlanText,
    });
    console.log(`  Keyset Mid (5,000 equiv):  ${resKeysetMid.executionTimeMs.toFixed(3)} ms [${resKeysetMid.planNode}]`);

    // 5. Deep Offset (Offset 9,000, Limit 20)
    const sqlOffsetDeep = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20 OFFSET 9000;
    `;
    const resOffsetDeep = await explainAnalyze(sqlOffsetDeep);
    metrics.push({
      queryName: 'Offset Deep (offset 9000, limit 20)',
      paginationType: 'offset',
      paginationDepth: 'Offset 9,000',
      hasIndex,
      planningTimeMs: resOffsetDeep.planningTimeMs,
      executionTimeMs: resOffsetDeep.executionTimeMs,
      planNode: resOffsetDeep.planNode,
      actualRows: resOffsetDeep.actualRows,
      sharedHitBlocks: resOffsetDeep.sharedHitBlocks,
      rawPlanText: resOffsetDeep.rawPlanText,
    });
    console.log(`  Offset Deep (9,000):       ${resOffsetDeep.executionTimeMs.toFixed(3)} ms [${resOffsetDeep.planNode}]`);

    // 6. Deep Keyset (Offset 9,000 equivalent cursor)
    const deepCreatedAtIso = deepCursor.createdAt.toISOString();
    const sqlKeysetDeep = `
      SELECT "id", "teamId", "actorUserId", "type", "entityType", "entityId", "metadata", "createdAt"
      FROM "ActivityEvent"
      WHERE "teamId" = '${team.id}'
        AND (
          "createdAt" < '${deepCreatedAtIso}'
          OR ("createdAt" = '${deepCreatedAtIso}' AND "id" < '${deepCursor.id}')
        )
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 20;
    `;
    const resKeysetDeep = await explainAnalyze(sqlKeysetDeep);
    metrics.push({
      queryName: 'Keyset Deep (offset 9000 equivalent, limit 20)',
      paginationType: 'keyset',
      paginationDepth: 'Offset 9,000 equivalent',
      hasIndex,
      planningTimeMs: resKeysetDeep.planningTimeMs,
      executionTimeMs: resKeysetDeep.executionTimeMs,
      planNode: resKeysetDeep.planNode,
      actualRows: resKeysetDeep.actualRows,
      sharedHitBlocks: resKeysetDeep.sharedHitBlocks,
      rawPlanText: resKeysetDeep.rawPlanText,
    });
    console.log(`  Keyset Deep (9,000 equiv): ${resKeysetDeep.executionTimeMs.toFixed(3)} ms [${resKeysetDeep.planNode}]\n`);
  }

  try {
    // Phase 1: Benchmark WITH Composite Index
    await runQuerySuite(true);

    // Phase 2: Drop Composite Index temporarily to measure unindexed performance
    console.log('[Index Test] Temporarily dropping composite index "ActivityEvent_teamId_createdAt_id_idx"...');
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "ActivityEvent_teamId_createdAt_id_idx";`);
    await prisma.$executeRawUnsafe(`ANALYZE "ActivityEvent";`);

    await runQuerySuite(false);
  } finally {
    // Phase 3: ALWAYS restore Composite Index in disposable database
    console.log('[Index Test] Restoring composite B-tree index "ActivityEvent_teamId_createdAt_id_idx"...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ActivityEvent_teamId_createdAt_id_idx"
      ON "ActivityEvent"("teamId", "createdAt" DESC, "id" DESC);
    `);
    await prisma.$executeRawUnsafe(`ANALYZE "ActivityEvent";`);
    console.log('[Index Test] Composite index successfully restored and verified.\n');
  }

  return { totalRecords, metrics };
}

// Auto-execute if run directly
if (require.main === module) {
  runBenchmarks()
    .then(({ totalRecords, metrics }) => {
      console.log('========================================================================================');
      console.log('   BENCHMARK SUMMARY MATRIX (10,000 Records in Disposable PostgreSQL)');
      console.log('========================================================================================');
      console.log(
        'Pagination Method'.padEnd(25) +
        'Depth'.padEnd(16) +
        'Indexed?'.padEnd(12) +
        'Plan Node'.padEnd(16) +
        'Exec Time (ms)'.padEnd(16) +
        'Plan Time (ms)'
      );
      console.log('----------------------------------------------------------------------------------------');
      for (const m of metrics) {
        console.log(
          m.paginationType.toUpperCase().padEnd(25) +
          m.paginationDepth.padEnd(16) +
          (m.hasIndex ? 'YES (B-tree)' : 'NO (Unindexed)').padEnd(12) +
          m.planNode.padEnd(16) +
          m.executionTimeMs.toFixed(3).padEnd(16) +
          m.planningTimeMs.toFixed(3)
        );
      }
      console.log('========================================================================================\n');
    })
    .catch((err) => {
      console.error('[BENCHMARK ERROR]', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
