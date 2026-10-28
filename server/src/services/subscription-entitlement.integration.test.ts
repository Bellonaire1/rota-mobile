import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingPeriodStatus, BillingSubscriptionStatus, TeamRole } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AppError } from '../errors/AppError';
import { reconciliationIntegrationSkipReason } from './reconciliation-test-safety';
import { resolveSubscriptionEntitlement } from './subscription-entitlement.service';
import { shiftService } from './shift.service';
import { teamService } from './team.service';

type TeamFixture = { teamId: string; ownerId: string };

const makeTeam = async (): Promise<TeamFixture> => {
  const owner = await prisma.user.create({
    data: { email: `entitlement-owner-${randomUUID()}@example.com`, name: 'Entitlement Owner', passwordHash: 'test-hash' },
  });
  const team = await prisma.team.create({ data: { name: `Entitlement Team ${randomUUID()}`, createdByUserId: owner.id } });
  await prisma.teamMembership.create({ data: { teamId: team.id, userId: owner.id, role: TeamRole.OWNER } });
  return { teamId: team.id, ownerId: owner.id };
};

const makeUser = async (): Promise<string> => {
  const user = await prisma.user.create({
    data: { email: `entitlement-member-${randomUUID()}@example.com`, name: 'Entitlement Member', passwordHash: 'test-hash' },
  });
  return user.id;
};

const createSubscription = async (
  teamId: string,
  status: BillingSubscriptionStatus,
  billableStaffSeats: number,
  planCode: 'STARTER' | 'TEAM' | 'BUSINESS' = 'STARTER',
  periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
) => {
  const plan = await prisma.billingPlan.findUniqueOrThrow({ where: { code: planCode } });
  const price = await prisma.billingPlanPrice.findFirstOrThrow({
    where: {
      planId: plan.id,
      effectiveTo: null,
      currency: 'USD',
      ...(planCode === 'STARTER'
        ? { monthlyPriceCents: 2_000, includedStaffSeats: 5, extraStaffSeatPriceCents: 0 }
        : planCode === 'TEAM'
          ? { monthlyPriceCents: 5_000, includedStaffSeats: 15, extraStaffSeatPriceCents: 300 }
          : { monthlyPriceCents: 12_000, includedStaffSeats: 40, extraStaffSeatPriceCents: 200 }),
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const subscription = await prisma.billingSubscription.create({
    data: { teamId, planId: plan.id, priceId: price.id, status, currency: 'USD', currentPeriodStart: new Date(Date.now() - 1_000), currentPeriodEnd: periodEnd },
  });

  if (status === BillingSubscriptionStatus.PENDING_CHECKOUT) {
    await prisma.billingIdempotencyKey.create({
      data: {
        scope: `team-billing-checkout:${teamId}`,
        key: `pending-${randomUUID()}`,
        requestHash: randomUUID().replaceAll('-', ''),
        status: 'IN_PROGRESS',
        teamId,
        expiresAt: new Date(Date.now() + 86_400_000),
        responseBody: { state: 'RESERVED', billableStaffSeats },
      },
    });
  } else {
    const extraStaffSeats = Math.max(0, billableStaffSeats - price.includedStaffSeats);
    const extraStaffAmountCents = extraStaffSeats * price.extraStaffSeatPriceCents;
    await prisma.billingPeriod.create({
      data: {
        subscriptionId: subscription.id,
        sequence: 1,
        startsAt: new Date(Date.now() - 1_000),
        endsAt: periodEnd,
        planCodeSnapshot: plan.code,
        monthlyPriceCents: price.monthlyPriceCents,
        includedStaffSeats: price.includedStaffSeats,
        extraStaffSeatPriceCents: price.extraStaffSeatPriceCents,
        billableStaffSeats,
        extraStaffSeats,
        baseAmountCents: price.monthlyPriceCents,
        extraSeatAmountCents: extraStaffAmountCents,
        totalAmountCents: price.monthlyPriceCents + extraStaffAmountCents,
        currency: 'USD',
      },
    });
  }
  return subscription.id;
};

const createShift = (teamId: string, ownerId: string, assignedToUserId: string, day = '01') => shiftService.create(teamId, ownerId, {
  title: 'Entitlement shift',
  assignedToUserId,
  startsAt: new Date(`2035-01-${day}T09:00:00.000Z`),
  endsAt: new Date(`2035-01-${day}T17:00:00.000Z`),
});

const assertConflict = async (operation: Promise<unknown>, message: RegExp): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => error instanceof AppError && error.statusCode === 409 && message.test(error.message));
};

describe('subscription entitlement enforcement', { concurrency: false, skip: reconciliationIntegrationSkipReason() }, () => {
  after(async () => prisma.$disconnect());

  it('excludes OWNER, allows the fifth STARTER seat, and rejects the sixth', async () => {
    const team = await makeTeam();
    await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 5);
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    for (const userId of users.slice(0, 5)) await teamService.addMember(team.teamId, team.ownerId, { userId, role: TeamRole.STAFF });
    await assertConflict(teamService.addMember(team.teamId, team.ownerId, { userId: users[5], role: TeamRole.STAFF }), /seat entitlement|Starter five-seat cap/);
    const entitlement = await resolveSubscriptionEntitlement(prisma, team.teamId);
    assert.equal(entitlement.currentBillableStaffSeats, 5);
  });

  it('counts TEAM paid extras and preserves STAFF-to-MANAGER seat count', async () => {
    const team = await makeTeam();
    await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 17, 'TEAM');
    const users = await Promise.all(Array.from({ length: 18 }, () => makeUser()));
    for (const userId of users.slice(0, 16)) await teamService.addMember(team.teamId, team.ownerId, { userId, role: TeamRole.STAFF });
    await teamService.addMember(team.teamId, team.ownerId, { userId: users[16], role: TeamRole.MANAGER });
    await teamService.updateMemberRole(team.teamId, team.ownerId, users[0], { role: TeamRole.MANAGER });
    await assertConflict(teamService.addMember(team.teamId, team.ownerId, { userId: users[17], role: TeamRole.STAFF }), /paid billable seat entitlement/);
    assert.equal((await resolveSubscriptionEntitlement(prisma, team.teamId)).currentBillableStaffSeats, 17);
  });

  it('does not let pending checkout membership changes exceed the reserved seat snapshot', async () => {
    const team = await makeTeam();
    await createSubscription(team.teamId, BillingSubscriptionStatus.PENDING_CHECKOUT, 1);
    const users = await Promise.all([makeUser(), makeUser()]);
    await teamService.addMember(team.teamId, team.ownerId, { userId: users[0], role: TeamRole.STAFF });
    await assertConflict(teamService.addMember(team.teamId, team.ownerId, { userId: users[1], role: TeamRole.STAFF }), /paid billable seat entitlement/);
  });

  it('serializes concurrent additions at the paid seat boundary', async () => {
    const team = await makeTeam();
    await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 1);
    const users = await Promise.all([makeUser(), makeUser()]);
    const results = await Promise.allSettled(users.map((userId) => teamService.addMember(team.teamId, team.ownerId, { userId, role: TeamRole.STAFF })));
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await resolveSubscriptionEntitlement(prisma, team.teamId)).currentBillableStaffSeats, 1);
  });

  it('allows operational writes through active, past-due, grace, and expired-within-grace states', async () => {
    const team = await makeTeam();
    const memberId = await makeUser();
    await teamService.addMember(team.teamId, team.ownerId, { userId: memberId, role: TeamRole.STAFF });
    const subscriptionId = await createSubscription(team.teamId, BillingSubscriptionStatus.PAST_DUE, 1);
    await createShift(team.teamId, team.ownerId, memberId, '01');
    await prisma.billingSubscription.update({ where: { id: subscriptionId }, data: { status: BillingSubscriptionStatus.GRACE } });
    await createShift(team.teamId, team.ownerId, memberId, '02');
    await prisma.billingSubscription.update({ where: { id: subscriptionId }, data: { status: BillingSubscriptionStatus.ACTIVE, currentPeriodEnd: new Date(Date.now() - 1_000) } });
    await createShift(team.teamId, team.ownerId, memberId, '03');
  });

  it('blocks all shift mutations when suspended, canceled, or grace has expired', async () => {
    const team = await makeTeam();
    const memberId = await makeUser();
    await teamService.addMember(team.teamId, team.ownerId, { userId: memberId, role: TeamRole.STAFF });
    const subscriptionId = await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 1);
    const expiredStart = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    const expiredEnd = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await prisma.billingSubscription.update({ where: { id: subscriptionId }, data: { currentPeriodStart: expiredStart, currentPeriodEnd: expiredEnd } });
    assert.equal((await resolveSubscriptionEntitlement(prisma, team.teamId)).status, BillingSubscriptionStatus.SUSPENDED);
    await assertConflict(createShift(team.teamId, team.ownerId, memberId), /operational changes are unavailable/);
    await prisma.billingSubscription.update({ where: { id: subscriptionId }, data: { status: BillingSubscriptionStatus.CANCELED } });
    await assertConflict(createShift(team.teamId, team.ownerId, memberId), /operational changes are unavailable/);
  });

  it('preserves unsubscribed legacy team behavior and allows safe reductions', async () => {
    const team = await makeTeam();
    const memberId = await makeUser();
    await teamService.addMember(team.teamId, team.ownerId, { userId: memberId, role: TeamRole.STAFF });
    await createShift(team.teamId, team.ownerId, memberId);

    const subscribed = await makeTeam();
    await createSubscription(subscribed.teamId, BillingSubscriptionStatus.ACTIVE, 0);
    const overLimitMember = await makeUser();
    await prisma.teamMembership.create({ data: { teamId: subscribed.teamId, userId: overLimitMember, role: TeamRole.STAFF } });
    await teamService.removeMember(subscribed.teamId, subscribed.ownerId, overLimitMember);
    assert.equal((await resolveSubscriptionEntitlement(prisma, subscribed.teamId)).currentBillableStaffSeats, 0);
  });

  it('does not create financial records when membership expansion is denied', async () => {
    const team = await makeTeam();
    await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 0);
    const memberId = await makeUser();
    const before = await prisma.billingLedgerTransaction.count({ where: { teamId: team.teamId } });
    await assertConflict(teamService.addMember(team.teamId, team.ownerId, { userId: memberId, role: TeamRole.STAFF }), /paid billable seat entitlement/);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { teamId: team.teamId } }), before);
  });

  it('uses the latest applicable non-VOID period and ignores a newer VOID period', async () => {
    const team = await makeTeam();
    const subscriptionId = await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 2);
    const valid = await prisma.billingPeriod.findFirstOrThrow({ where: { subscriptionId } });
    await prisma.billingPeriod.create({
      data: {
        subscriptionId,
        sequence: 2,
        startsAt: new Date(Date.now() - 500),
        endsAt: valid.endsAt,
        planCodeSnapshot: valid.planCodeSnapshot,
        monthlyPriceCents: valid.monthlyPriceCents,
        includedStaffSeats: valid.includedStaffSeats,
        extraStaffSeatPriceCents: valid.extraStaffSeatPriceCents,
        billableStaffSeats: 99,
        extraStaffSeats: valid.extraStaffSeats,
        baseAmountCents: valid.baseAmountCents,
        extraSeatAmountCents: valid.extraSeatAmountCents,
        totalAmountCents: valid.totalAmountCents,
        currency: valid.currency,
        status: BillingPeriodStatus.VOID,
      },
    });
    const entitlement = await resolveSubscriptionEntitlement(prisma, team.teamId);
    assert.equal(entitlement.paidBillableStaffSeats, 2);
  });

  it('fails closed for membership additions when every applicable period is VOID', async () => {
    const team = await makeTeam();
    const subscriptionId = await createSubscription(team.teamId, BillingSubscriptionStatus.ACTIVE, 1);
    await prisma.billingPeriod.updateMany({ where: { subscriptionId }, data: { status: BillingPeriodStatus.VOID } });
    const entitlement = await resolveSubscriptionEntitlement(prisma, team.teamId);
    assert.equal(entitlement.paidBillableStaffSeats, null);
    await assertConflict(
      teamService.addMember(team.teamId, team.ownerId, { userId: await makeUser(), role: TeamRole.STAFF }),
      /paid billable seat entitlement/,
    );
  });
});
