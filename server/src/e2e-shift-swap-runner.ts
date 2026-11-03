import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import assert from 'assert';
import { PrismaClient, ShiftStatus, ShiftSwapStatus, TeamRole } from '@prisma/client';
import { authIntegrationSkipReason } from './auth/auth-test-safety';

// 1. Locate and load ONLY server/.env.auth-test.local
const envPath = path.resolve(__dirname, '../.env.auth-test.local');
if (!fs.existsSync(envPath)) {
  console.error('[E2E ERROR] Missing .env.auth-test.local at:', envPath);
  process.exit(1);
}

const fileContent = fs.readFileSync(envPath, 'utf8');
const testEnv = dotenv.parse(fileContent);

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] = value;
}

// 2. Safety Guards
if (process.env.NODE_ENV !== 'test') {
  console.error(`[E2E ERROR] Refusing execution: NODE_ENV must be "test"`);
  process.exit(1);
}

if (process.env.AUTH_TEST_DATABASE !== 'disposable') {
  console.error(`[E2E ERROR] Refusing execution: AUTH_TEST_DATABASE must be "disposable"`);
  process.exit(1);
}

const skipReason = authIntegrationSkipReason(process.env);
if (skipReason) {
  console.error(`[E2E ERROR] Safety guard violation: ${skipReason}`);
  process.exit(1);
}

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
  console.error('[E2E ERROR] Database host mismatch! Refusing execution.');
  process.exit(1);
}

const dbName = dbUrl.pathname.replace(/^\//, '');
if (dbName !== APPROVED_DB) {
  console.error(`[E2E ERROR] Database name must be "${APPROVED_DB}".`);
  process.exit(1);
}

const BASE_URL = 'http://localhost:5000/api/v1';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
});

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL';
  httpStatus?: number;
  expectedStatus?: number;
  details?: string;
}

const results: TestResult[] = [];

function recordPass(category: string, name: string, httpStatus: number, details?: string) {
  results.push({ name, category, status: 'PASS', httpStatus, expectedStatus: httpStatus, details });
  console.log(`  [PASS] ${name} (HTTP ${httpStatus}) ${details ? '- ' + details : ''}`);
}

function recordFail(category: string, name: string, httpStatus: number, expectedStatus: number, details: string) {
  results.push({ name, category, status: 'FAIL', httpStatus, expectedStatus, details });
  console.error(`  [FAIL] ${name} (Got HTTP ${httpStatus}, expected ${expectedStatus}) - ${details}`);
}

async function loginUser(email: string): Promise<string> {
  const password = process.env.AUTH_TEST_FIXTURE_PASSWORD || 'TestPassword123!';
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email} with HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.accessToken;
}

async function runAllTests() {
  console.log('================================================================');
  console.log('   ROTA AUTONOMOUS E2E SHIFT SWAP VERIFICATION SUITE');
  console.log('================================================================');
  console.log(`[Safety Guard] Target Host:    ${APPROVED_HOST}`);
  console.log(`[Safety Guard] Target DB:      ${APPROVED_DB}`);
  console.log(`[Safety Guard] Target Project: calm-bird-93784411 (disposable)`);
  console.log(`[Safety Guard] Server API:     ${BASE_URL}`);
  console.log('================================================================\n');

  // Verify DB connectivity
  const dbCheck = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`;
  assert.strictEqual(dbCheck[0].result, 1);
  console.log('[Setup] Database connection confirmed.\n');

  // Load Fixture Users & Team
  const [managerUser, staffA, staffB, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'owner.manager@example.com' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'staff.a@example.com' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'staff.b@example.com' } }),
    prisma.team.findFirstOrThrow({ where: { name: 'Alpha Team' } }),
  ]);

  console.log('[Setup] Authenticating test sessions...');
  const [tokenOwner, tokenStaffA, tokenStaffB] = await Promise.all([
    loginUser('owner.manager@example.com'),
    loginUser('staff.a@example.com'),
    loginUser('staff.b@example.com'),
  ]);
  console.log('[Setup] Sessions established for Owner, Staff A, and Staff B.\n');

  // Find base scheduled shifts for Alpha Team
  let shift1 = await prisma.shift.findFirstOrThrow({
    where: { teamId: team.id, title: 'Morning Support', status: ShiftStatus.SCHEDULED },
  });
  let shift2 = await prisma.shift.findFirstOrThrow({
    where: { teamId: team.id, title: 'Evening Coverage', status: ShiftStatus.SCHEDULED },
  });

  // Ensure initial assignments: shift1 -> Staff A, shift2 -> Staff B
  if (shift1.assignedToUserId !== staffA.id || shift2.assignedToUserId !== staffB.id) {
    console.log('[Setup] Resetting base shift assignments to initial state...');
    await prisma.shift.update({ where: { id: shift1.id }, data: { assignedToUserId: staffA.id } });
    await prisma.shift.update({ where: { id: shift2.id }, data: { assignedToUserId: staffB.id } });
    shift1 = await prisma.shift.findUniqueOrThrow({ where: { id: shift1.id } });
    shift2 = await prisma.shift.findUniqueOrThrow({ where: { id: shift2.id } });
  }

  // Ensure no lingering active swap requests on base shifts
  await prisma.shiftSwapRequest.deleteMany({
    where: {
      teamId: team.id,
      OR: [
        { sourceShiftId: { in: [shift1.id, shift2.id] } },
        { targetShiftId: { in: [shift1.id, shift2.id] } },
      ],
    },
  });

  console.log('--- TEST 1: SWAP PROPOSAL (Staff A -> Staff B) ---');
  let swapId = '';
  {
    const res = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenStaffA}`,
      },
      body: JSON.stringify({
        sourceShiftId: shift1.id,
        targetShiftId: shift2.id,
      }),
    });

    const body = await res.json();
    if (res.status === 201 && body.shiftSwap?.status === 'PENDING_PEER') {
      swapId = body.shiftSwap.id;
      recordPass('Core Workflow', 'Staff A submits swap proposal for Morning Support & Evening Coverage', 201, `Swap ID: ${swapId}`);
    } else {
      recordFail('Core Workflow', 'Staff A submits swap proposal', res.status, 201, JSON.stringify(body));
    }

    // Verify DB: assignments untouched
    const checkS1 = await prisma.shift.findUniqueOrThrow({ where: { id: shift1.id } });
    const checkS2 = await prisma.shift.findUniqueOrThrow({ where: { id: shift2.id } });
    assert.strictEqual(checkS1.assignedToUserId, staffA.id, 'Shift 1 must remain with Staff A');
    assert.strictEqual(checkS2.assignedToUserId, staffB.id, 'Shift 2 must remain with Staff B');
    recordPass('Database Verification', 'Original shift assignments unchanged after proposal', 200, 'Shift 1: Staff A, Shift 2: Staff B');
  }

  console.log('\n--- TEST 2: PEER ACCEPTANCE (Staff B accepts proposal) ---');
  {
    const res = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${swapId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenStaffB}`,
      },
      body: JSON.stringify({ action: 'accept' }),
    });

    const body = await res.json();
    if (res.status === 200 && body.shiftSwap?.status === 'PENDING_MANAGER') {
      recordPass('Core Workflow', 'Staff B accepts swap proposal, transitioning to PENDING_MANAGER', 200, `peerRespondedAt: ${body.shiftSwap.peerRespondedAt}`);
    } else {
      recordFail('Core Workflow', 'Staff B accepts swap proposal', res.status, 200, JSON.stringify(body));
    }

    // Verify DB: assignments still untouched
    const checkS1 = await prisma.shift.findUniqueOrThrow({ where: { id: shift1.id } });
    const checkS2 = await prisma.shift.findUniqueOrThrow({ where: { id: shift2.id } });
    assert.strictEqual(checkS1.assignedToUserId, staffA.id, 'Shift 1 must remain with Staff A');
    assert.strictEqual(checkS2.assignedToUserId, staffB.id, 'Shift 2 must remain with Staff B');
    recordPass('Database Verification', 'Shift assignments still unchanged awaiting manager review', 200, 'Shift 1: Staff A, Shift 2: Staff B');
  }

  console.log('\n--- TEST 3: MANAGER APPROVAL (Owner approves swap) ---');
  {
    const res = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${swapId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenOwner}`,
      },
      body: JSON.stringify({ action: 'approve' }),
    });

    const body = await res.json();
    if (res.status === 200 && body.shiftSwap?.status === 'APPROVED') {
      recordPass('Core Workflow', 'Owner approves swap request, transitioning to APPROVED', 200, `reviewedBy: ${body.shiftSwap.reviewedByUserId}`);
    } else {
      recordFail('Core Workflow', 'Owner approves swap request', res.status, 200, JSON.stringify(body));
    }

    // Verify directly in PostgreSQL
    const updatedS1 = await prisma.shift.findUniqueOrThrow({ where: { id: shift1.id } });
    const updatedS2 = await prisma.shift.findUniqueOrThrow({ where: { id: shift2.id } });
    assert.strictEqual(updatedS1.assignedToUserId, staffB.id, 'Morning Support must now belong to Staff B');
    assert.strictEqual(updatedS2.assignedToUserId, staffA.id, 'Evening Coverage must now belong to Staff A');

    const dbSwap = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: swapId } });
    assert.strictEqual(dbSwap.status, ShiftSwapStatus.APPROVED);
    assert.strictEqual(dbSwap.reviewedByUserId, managerUser.id);
    assert.ok(dbSwap.reviewedAt !== null, 'reviewedAt timestamp must be set');
    assert.strictEqual(dbSwap.rejectionReason, null, 'Approval must not have rejection reason');

    recordPass('Database Verification', 'Atomic shift swap exchange confirmed in PostgreSQL', 200, 'Morning Support -> Staff B, Evening Coverage -> Staff A');
  }

  console.log('\n--- TEST 4: PEER DECLINE WORKFLOW ---');
  {
    const now = Date.now();
    const dShift1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Decline Shift A ${now}`,
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 10 * 86400000),
        endsAt: new Date(Date.now() + 10 * 86400000 + 8 * 3600000),
      },
    });
    const dShift2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Decline Shift B ${now}`,
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 11 * 86400000),
        endsAt: new Date(Date.now() + 11 * 86400000 + 8 * 3600000),
      },
    });

    const propRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ sourceShiftId: dShift1.id, targetShiftId: dShift2.id }),
    });
    const propBody = await propRes.json();
    assert.strictEqual(propRes.status, 201);
    const dSwapId = propBody.shiftSwap.id;

    // Staff B declines
    const decRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${dSwapId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffB}` },
      body: JSON.stringify({ action: 'decline' }),
    });
    const decBody = await decRes.json();
    if (decRes.status === 200 && decBody.shiftSwap?.status === 'DECLINED') {
      recordPass('Core Workflow', 'Peer decline transitions request directly to DECLINED', 200);
    } else {
      recordFail('Core Workflow', 'Peer decline', decRes.status, 200, JSON.stringify(decBody));
    }

    // Verify DB assignments unchanged
    const checkDS1 = await prisma.shift.findUniqueOrThrow({ where: { id: dShift1.id } });
    const checkDS2 = await prisma.shift.findUniqueOrThrow({ where: { id: dShift2.id } });
    assert.strictEqual(checkDS1.assignedToUserId, staffA.id);
    assert.strictEqual(checkDS2.assignedToUserId, staffB.id);
    recordPass('Database Verification', 'Shift assignments unaffected after peer decline', 200);
  }

  console.log('\n--- TEST 5: MANAGER REJECTION WORKFLOW ---');
  {
    const now = Date.now();
    const rShift1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Reject Shift A ${now}`,
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 12 * 86400000),
        endsAt: new Date(Date.now() + 12 * 86400000 + 8 * 3600000),
      },
    });
    const rShift2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Reject Shift B ${now}`,
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 13 * 86400000),
        endsAt: new Date(Date.now() + 13 * 86400000 + 8 * 3600000),
      },
    });

    const propRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ sourceShiftId: rShift1.id, targetShiftId: rShift2.id }),
    });
    const propBody = await propRes.json();
    const rSwapId = propBody.shiftSwap.id;

    // Staff B accepts
    await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${rSwapId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffB}` },
      body: JSON.stringify({ action: 'accept' }),
    });

    // Owner rejects with reason
    const rejectionReason = 'Test rejection';
    const rejRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${rSwapId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ action: 'reject', reason: rejectionReason }),
    });
    const rejBody = await rejRes.json();
    if (rejRes.status === 200 && rejBody.shiftSwap?.status === 'REJECTED') {
      recordPass('Core Workflow', 'Manager rejects swap proposal with reason', 200, `Reason: "${rejectionReason}"`);
    } else {
      recordFail('Core Workflow', 'Manager rejects swap', rejRes.status, 200, JSON.stringify(rejBody));
    }

    // Verify DB
    const dbSwap = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: rSwapId } });
    assert.strictEqual(dbSwap.status, ShiftSwapStatus.REJECTED);
    assert.strictEqual(dbSwap.rejectionReason, rejectionReason);
    assert.strictEqual(dbSwap.reviewedByUserId, managerUser.id);
    assert.ok(dbSwap.reviewedAt !== null, 'reviewedAt timestamp must be set');
    const checkRS1 = await prisma.shift.findUniqueOrThrow({ where: { id: rShift1.id } });
    const checkRS2 = await prisma.shift.findUniqueOrThrow({ where: { id: rShift2.id } });
    assert.strictEqual(checkRS1.assignedToUserId, staffA.id);
    assert.strictEqual(checkRS2.assignedToUserId, staffB.id);
    recordPass('Database Verification', 'Rejection reason and actor persisted, shifts remain unchanged', 200);

    // Verify supported GET list endpoint returns the rejected swap with rejectionReason
    const listRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps?status=REJECTED`, {
      headers: { Authorization: `Bearer ${tokenOwner}` },
    });
    const listBody = await listRes.json();
    assert.strictEqual(listRes.status, 200);
    const foundSwap = listBody.shiftSwaps?.find((s: any) => s.id === rSwapId);
    assert.ok(foundSwap, 'Rejected swap must be present in GET list response');
    assert.strictEqual(foundSwap.rejectionReason, 'Test rejection');
  }

  console.log('\n--- TEST 6: REQUESTER CANCELLATION WORKFLOW ---');
  {
    const now = Date.now();
    const cShift1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Cancel Shift A ${now}`,
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 14 * 86400000),
        endsAt: new Date(Date.now() + 14 * 86400000 + 8 * 3600000),
      },
    });
    const cShift2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: `Cancel Shift B ${now}`,
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 15 * 86400000),
        endsAt: new Date(Date.now() + 15 * 86400000 + 8 * 3600000),
      },
    });

    const propRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ sourceShiftId: cShift1.id, targetShiftId: cShift2.id }),
    });
    const propBody = await propRes.json();
    const cSwapId = propBody.shiftSwap.id;

    // Requester (Staff A) cancels
    const canRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${cSwapId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStaffA}` },
    });
    const canBody = await canRes.json();
    if (canRes.status === 200 && canBody.shiftSwap?.status === 'CANCELLED') {
      recordPass('Core Workflow', 'Requester successfully cancels unresolved swap request', 200);
    } else {
      recordFail('Core Workflow', 'Requester cancel', canRes.status, 200, JSON.stringify(canBody));
    }

    // Verify DB
    const dbSwap = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: cSwapId } });
    assert.strictEqual(dbSwap.status, ShiftSwapStatus.CANCELLED);
    const checkCS1 = await prisma.shift.findUniqueOrThrow({ where: { id: cShift1.id } });
    const checkCS2 = await prisma.shift.findUniqueOrThrow({ where: { id: cShift2.id } });
    assert.strictEqual(checkCS1.assignedToUserId, staffA.id);
    assert.strictEqual(checkCS2.assignedToUserId, staffB.id);
    recordPass('Database Verification', 'Shift assignments unaffected after cancellation', 200);
  }

  console.log('\n--- TEST 7: SECURITY & CONFLICT HANDLERS ---');
  {
    // 7A: Unauthorized User (Missing JWT) -> 401
    const unauthRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceShiftId: shift1.id, targetShiftId: shift2.id }),
    });
    if (unauthRes.status === 401) {
      recordPass('Security & RBAC', 'Unauthenticated request rejected with HTTP 401', 401);
    } else {
      recordFail('Security & RBAC', 'Unauthenticated request', unauthRes.status, 401, 'Expected 401');
    }

    // 7B: Wrong Role -> Non-manager attempting manager review -> 403
    const fakeSwap = await prisma.shiftSwapRequest.create({
      data: {
        teamId: team.id,
        sourceShiftId: shift1.id,
        targetShiftId: shift2.id,
        requestingUserId: staffA.id,
        receivingUserId: staffB.id,
        sourceShiftUpdatedAt: shift1.updatedAt,
        targetShiftUpdatedAt: shift2.updatedAt,
        status: ShiftSwapStatus.PENDING_MANAGER,
      },
    });

    const staffReviewRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${fakeSwap.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (staffReviewRes.status === 403) {
      recordPass('Security & RBAC', 'Staff member denied manager review action with HTTP 403', 403);
    } else {
      recordFail('Security & RBAC', 'Staff review permission check', staffReviewRes.status, 403, 'Expected 403');
    }

    // 7C: Foreign Team Isolation -> 404
    const foreignTeamId = '00000000-0000-0000-0000-000000000000';
    const foreignRes = await fetch(`${BASE_URL}/teams/${foreignTeamId}/shift-swaps/${fakeSwap.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (foreignRes.status === 404) {
      recordPass('Security & RBAC', 'Foreign-team mutation rejected with HTTP 404', 404);
    } else {
      recordFail('Security & RBAC', 'Foreign team isolation', foreignRes.status, 404, 'Expected 404');
    }

    // 7D: Premature Manager Approval (Status still PENDING_PEER) -> 409
    const pendingPeerSwap = await prisma.shiftSwapRequest.create({
      data: {
        teamId: team.id,
        sourceShiftId: shift1.id,
        targetShiftId: shift2.id,
        requestingUserId: staffA.id,
        receivingUserId: staffB.id,
        sourceShiftUpdatedAt: shift1.updatedAt,
        targetShiftUpdatedAt: shift2.updatedAt,
        status: ShiftSwapStatus.PENDING_PEER,
      },
    });

    const prematureRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${pendingPeerSwap.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (prematureRes.status === 409) {
      recordPass('Conflict Handling', 'Manager approval before peer acceptance rejected with HTTP 409', 409);
    } else {
      recordFail('Conflict Handling', 'Premature manager approval', prematureRes.status, 409, 'Expected 409');
    }

    // Clean up temporary test swaps
    await prisma.shiftSwapRequest.deleteMany({ where: { id: { in: [fakeSwap.id, pendingPeerSwap.id] } } });

    // 7E: Duplicate Active Swap Requests -> 409
    // Provision fresh shifts specifically assigned to Staff A and Staff B
    const dupS1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Dup Source Shift',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 18 * 86400000),
        endsAt: new Date(Date.now() + 18 * 86400000 + 8 * 3600000),
      },
    });
    const dupS2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Dup Target Shift',
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 19 * 86400000),
        endsAt: new Date(Date.now() + 19 * 86400000 + 8 * 3600000),
      },
    });

    // Create first active swap
    const activeSwap = await prisma.shiftSwapRequest.create({
      data: {
        teamId: team.id,
        sourceShiftId: dupS1.id,
        targetShiftId: dupS2.id,
        requestingUserId: staffA.id,
        receivingUserId: staffB.id,
        sourceShiftUpdatedAt: dupS1.updatedAt,
        targetShiftUpdatedAt: dupS2.updatedAt,
        status: ShiftSwapStatus.PENDING_PEER,
      },
    });

    const dupRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ sourceShiftId: dupS1.id, targetShiftId: dupS2.id }),
    });
    if (dupRes.status === 409) {
      recordPass('Conflict Handling', 'Duplicate request on active shift rejected with HTTP 409', 409);
    } else {
      recordFail('Conflict Handling', 'Duplicate request check', dupRes.status, 409, 'Expected 409');
    }
    await prisma.shiftSwapRequest.delete({ where: { id: activeSwap.id } });

    // 7F-1: Proposing with a Cancelled Shift -> 400
    const cancelledShift = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Cancelled Test Shift',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 20 * 86400000),
        endsAt: new Date(Date.now() + 20 * 86400000 + 8 * 3600000),
        status: ShiftStatus.CANCELLED,
      },
    });

    const staleRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
      body: JSON.stringify({ sourceShiftId: cancelledShift.id, targetShiftId: dupS2.id }),
    });
    if (staleRes.status === 400) {
      recordPass('Conflict Handling', 'Proposal with cancelled shift rejected with HTTP 400', 400, 'Requires scheduled shifts');
    } else {
      recordFail('Conflict Handling', 'Cancelled shift check', staleRes.status, 400, 'Expected 400');
    }

    // 7F-2: Approving a Shift that Became Cancelled After Proposal -> 409
    const cancelAfterPropShift1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Cancel After Prop S1',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 22 * 86400000),
        endsAt: new Date(Date.now() + 22 * 86400000 + 8 * 3600000),
        status: ShiftStatus.SCHEDULED,
      },
    });
    const cancelAfterPropShift2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Cancel After Prop S2',
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(Date.now() + 23 * 86400000),
        endsAt: new Date(Date.now() + 23 * 86400000 + 8 * 3600000),
        status: ShiftStatus.SCHEDULED,
      },
    });

    const postProp = await prisma.shiftSwapRequest.create({
      data: {
        teamId: team.id,
        sourceShiftId: cancelAfterPropShift1.id,
        targetShiftId: cancelAfterPropShift2.id,
        requestingUserId: staffA.id,
        receivingUserId: staffB.id,
        sourceShiftUpdatedAt: cancelAfterPropShift1.updatedAt,
        targetShiftUpdatedAt: cancelAfterPropShift2.updatedAt,
        status: ShiftSwapStatus.PENDING_MANAGER,
      },
    });

    // Manager cancels shift 1 before approving
    await prisma.shift.update({
      where: { id: cancelAfterPropShift1.id },
      data: { status: ShiftStatus.CANCELLED },
    });

    const approveCancelledRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${postProp.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (approveCancelledRes.status === 409) {
      recordPass('Conflict Handling', 'Manager approval of cancelled shift rejected with HTTP 409', 409, 'Cannot approve cancelled shifts');
    } else {
      recordFail('Conflict Handling', 'Approve cancelled shift', approveCancelledRes.status, 409, 'Expected 409');
    }

    // 7G: Schedule Overlap Detection on Approval -> 409
    const overlapTime = new Date(Date.now() + 25 * 86400000);
    const overlapShift1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Overlap Target',
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: overlapTime,
        endsAt: new Date(overlapTime.getTime() + 8 * 3600000),
      },
    });
    const overlapShiftExisting = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Staff A Existing At Same Time',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: overlapTime,
        endsAt: new Date(overlapTime.getTime() + 8 * 3600000),
      },
    });
    const overlapSourceShift = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Staff A Source Shift Other Time',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(overlapTime.getTime() + 48 * 3600000),
        endsAt: new Date(overlapTime.getTime() + 56 * 3600000),
      },
    });

    const overlapSwap = await prisma.shiftSwapRequest.create({
      data: {
        teamId: team.id,
        sourceShiftId: overlapSourceShift.id,
        targetShiftId: overlapShift1.id,
        requestingUserId: staffA.id,
        receivingUserId: staffB.id,
        sourceShiftUpdatedAt: overlapSourceShift.updatedAt,
        targetShiftUpdatedAt: overlapShift1.updatedAt,
        status: ShiftSwapStatus.PENDING_MANAGER,
      },
    });

    const overlapApproveRes = await fetch(`${BASE_URL}/teams/${team.id}/shift-swaps/${overlapSwap.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (overlapApproveRes.status === 409) {
      recordPass('Conflict Handling', 'Schedule overlap detected on approval; rejected with HTTP 409', 409);
    } else {
      recordFail('Conflict Handling', 'Overlap detection check', overlapApproveRes.status, 409, 'Expected 409');
    }

    // 7H: Concurrent Conflicting Creation -> Single Winner (201) & Loser (409)
    const baseTime = Date.now() + 30 * 86400000;
    const concSource = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Concurrent Source Shift',
        assignedToUserId: staffA.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(baseTime),
        endsAt: new Date(baseTime + 8 * 3600000),
      },
    });
    const concTarget1 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Concurrent Target 1',
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(baseTime + 24 * 3600000),
        endsAt: new Date(baseTime + 32 * 3600000),
      },
    });
    const concTarget2 = await prisma.shift.create({
      data: {
        teamId: team.id,
        title: 'Concurrent Target 2',
        assignedToUserId: staffB.id,
        createdByUserId: managerUser.id,
        startsAt: new Date(baseTime + 48 * 3600000),
        endsAt: new Date(baseTime + 56 * 3600000),
      },
    });

    const [resA, resB] = await Promise.all([
      fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
        body: JSON.stringify({ sourceShiftId: concSource.id, targetShiftId: concTarget1.id }),
      }),
      fetch(`${BASE_URL}/teams/${team.id}/shift-swaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStaffA}` },
        body: JSON.stringify({ sourceShiftId: concSource.id, targetShiftId: concTarget2.id }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    if (statuses[0] === 201 && statuses[1] === 409) {
      recordPass('Concurrency Safety', 'Concurrent competing creation resulted in exactly one 201 and one 409', 201, 'Atomic isolation verified');
    } else {
      recordFail('Concurrency Safety', 'Concurrent creation', statuses[0], 201, `Statuses: ${statuses.join(', ')}`);
    }

    // Verify in database: exactly one active swap exists for concSource
    const concSwaps = await prisma.shiftSwapRequest.findMany({
      where: { sourceShiftId: concSource.id },
    });
    assert.strictEqual(concSwaps.length, 1);
    recordPass('Database Verification', 'PostgreSQL contains exactly one active swap after concurrent race', 200);
  }

  console.log('\n================================================================');
  console.log('   E2E SHIFT SWAP TEST SUMMARY');
  console.log('================================================================');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Total Cases: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nFAILURES ENCOUNTERED:');
    for (const f of results.filter((r) => r.status === 'FAIL')) {
      console.error(`- [${f.category}] ${f.name}: Got ${f.httpStatus}, Expected ${f.expectedStatus} (${f.details})`);
    }
    process.exit(1);
  } else {
    console.log('\nALL AUTOMATED TESTS PASSED WITH 100% SUCCESS!');
  }
}

runAllTests()
  .catch((err) => {
    console.error('[E2E FATAL ERROR]', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
