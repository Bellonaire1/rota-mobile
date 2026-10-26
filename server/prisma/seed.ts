import { PrismaClient, BillingPlanCode } from '@prisma/client';
import { PLAN_CATALOG } from '../src/billing/pricing';

const prisma = new PrismaClient();
const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');

const seed = async (): Promise<void> => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    const billingPlan = await prisma.billingPlan.upsert({
      where: { code: plan.code as BillingPlanCode },
      update: {
        displayName: plan.code,
        active: true,
      },
      create: {
        code: plan.code as BillingPlanCode,
        displayName: plan.code,
        active: true,
      },
    });

    await prisma.billingPlanPrice.upsert({
      where: {
        planId_effectiveFrom: {
          planId: billingPlan.id,
          effectiveFrom,
        },
      },
      update: {
        monthlyPriceCents: plan.monthlyPriceCents,
        includedStaffSeats: plan.includedStaffSeats,
        extraStaffSeatPriceCents: plan.extraStaffSeatPriceCents,
        currency: 'USD',
        effectiveTo: null,
      },
      create: {
        planId: billingPlan.id,
        monthlyPriceCents: plan.monthlyPriceCents,
        includedStaffSeats: plan.includedStaffSeats,
        extraStaffSeatPriceCents: plan.extraStaffSeatPriceCents,
        currency: 'USD',
        effectiveFrom,
      },
    });
  }
};

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
