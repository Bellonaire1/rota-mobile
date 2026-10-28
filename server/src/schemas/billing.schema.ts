import { z } from 'zod';

export const billingTeamParamsSchema = z.object({
  teamId: z.string().uuid(),
});

export const checkoutBodySchema = z.object({
  planCode: z.enum(['STARTER', 'TEAM', 'BUSINESS']),
  recurring: z.boolean().optional(),
  planReservationKey: z.string().regex(/^[A-Za-z0-9._:-]{8,255}$/, 'Invalid plan reservation key').optional(),
}).strict();

export type CheckoutInput = z.infer<typeof checkoutBodySchema>;
