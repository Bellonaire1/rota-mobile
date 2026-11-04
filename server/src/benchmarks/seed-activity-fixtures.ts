import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { ActivityEventType, PrismaClient } from '@prisma/client';
import { authIntegrationSkipReason } from '../auth/auth-test-safety';

// 1. Load exclusively server/.env.auth-test.local
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

// 2. Safety Guards
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
  console.error('[SAFETY ERROR] Database host mismatch! Refusing execution.');
  process.exit(1);
}
if (dbUrl.pathname.replace(/^\//, '') !== APPROVED_DB) {
  console.error(`[SAFETY ERROR] Database name must be "${APPROVED_DB}".`);
  process.exit(1);
}

export const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

export const BENCHMARK_TEAM_NAME = 'Activity Benchmark Team';
export const BENCHMARK_ACTOR_EMAIL = 'benchmark.actor@example.com';
export const TOTAL_RECORDS_TARGET = 10000;

export async function seedActivityFixtures(cleanExisting = false): Promise<{
  teamId: string;
  actorUserId: string;
  totalRecords: number;
}> {
  console.log('========================================================');
  console.log('  ROTA 10,000-RECORD SYNTHETIC ACTIVITY SEEDER');
  console.log('========================================================');
  console.log(`[Safety Guard] Target Host:    ${APPROVED_HOST}`);
  console.log(`[Safety Guard] Target DB:      ${APPROVED_DB}`);
  console.log(`[Safety Guard] Target Project: calm-bird-93784411 (disposable)`);
  console.log('========================================================\n');

  // 1. Create or load dedicated benchmark actor
  const passwordHash = await bcrypt.hash('BenchmarkSecret123!', 10);
  const actor = await prisma.user.upsert({
    where: { email: BENCHMARK_ACTOR_EMAIL },
    update: {},
    create: {
      email: BENCHMARK_ACTOR_EMAIL,
      name: 'Benchmark System Actor',
      passwordHash,
    },
  });

  // 2. Create or load dedicated benchmark team
  let team = await prisma.team.findFirst({
    where: { name: BENCHMARK_TEAM_NAME },
  });

  if (!team) {
    team = await prisma.team.create({
      data: {
        name: BENCHMARK_TEAM_NAME,
        createdByUserId: actor.id,
      },
    });
  }

  // Ensure membership
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: actor.id } },
    update: {},
    create: {
      teamId: team.id,
      userId: actor.id,
      role: 'OWNER',
    },
  });

  if (cleanExisting) {
    console.log('[Clean] Removing existing benchmark activity records...');
    const deleted = await prisma.activityEvent.deleteMany({
      where: { teamId: team.id },
    });
    console.log(`[Clean] Deleted ${deleted.count} existing records.\n`);
  }

  const existingCount = await prisma.activityEvent.count({
    where: { teamId: team.id },
  });

  if (existingCount >= TOTAL_RECORDS_TARGET && !cleanExisting) {
    console.log(`[Seed] Benchmark team already has ${existingCount} records (>= ${TOTAL_RECORDS_TARGET}).`);
    return { teamId: team.id, actorUserId: actor.id, totalRecords: existingCount };
  }

  const needed = TOTAL_RECORDS_TARGET - existingCount;
  console.log(`[Seed] Inserting ${needed} synthetic activity records in batches...`);

  const eventTypes: ActivityEventType[] = [
    ActivityEventType.SHIFT_CREATED,
    ActivityEventType.SHIFT_UPDATED,
    ActivityEventType.SHIFT_CANCELLED,
    ActivityEventType.MEMBER_ADDED,
    ActivityEventType.MEMBER_ROLE_CHANGED,
    ActivityEventType.MEMBER_REMOVED,
    ActivityEventType.SWAP_REQUESTED,
    ActivityEventType.SWAP_PEER_ACCEPTED,
    ActivityEventType.SWAP_PEER_DECLINED,
    ActivityEventType.SWAP_APPROVED,
    ActivityEventType.SWAP_REJECTED,
    ActivityEventType.SWAP_CANCELLED,
  ];

  const BATCH_SIZE = 1000;
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const stepMs = Math.floor(ninetyDaysMs / TOTAL_RECORDS_TARGET);

  let inserted = 0;
  const startTime = Date.now();

  while (inserted < needed) {
    const currentBatchSize = Math.min(BATCH_SIZE, needed - inserted);
    const batchData = [];

    for (let i = 0; i < currentBatchSize; i++) {
      const idx = existingCount + inserted + i;
      const eventType = eventTypes[idx % eventTypes.length];
      const entityType = eventType.startsWith('SHIFT_')
        ? 'SHIFT'
        : eventType.startsWith('MEMBER_')
        ? 'MEMBERSHIP'
        : 'SHIFT_SWAP';

      // Distribute timestamps over the past 90 days chronologically
      const createdAt = new Date(now - ninetyDaysMs + idx * stepMs);

      batchData.push({
        id: randomUUID(),
        teamId: team.id,
        actorUserId: actor.id,
        type: eventType,
        entityType,
        entityId: randomUUID(),
        metadata: {
          batch: Math.floor(idx / BATCH_SIZE),
          index: idx,
          note: `Synthetic activity event ${idx}`,
        },
        createdAt,
      });
    }

    await prisma.activityEvent.createMany({
      data: batchData,
    });

    inserted += currentBatchSize;
    process.stdout.write(`  Progress: ${inserted}/${needed} records inserted...\r`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const totalCount = await prisma.activityEvent.count({ where: { teamId: team.id } });
  console.log(`\n[Success] Seeded ${inserted} records in ${elapsed}s. Total records: ${totalCount}\n`);

  return { teamId: team.id, actorUserId: actor.id, totalRecords: totalCount };
}

// Auto-execute if run directly
if (require.main === module) {
  const clean = process.argv.includes('--clean');
  seedActivityFixtures(clean)
    .catch((err) => {
      console.error('[SEED ERROR]', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
