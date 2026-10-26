import { z } from 'zod';

export const billingTeamParamsSchema = z.object({
  teamId: z.string().uuid(),
});

export const checkoutBodySchema = z.object({
  planCode: z.enum(['STARTER', 'TEAM', 'BUSINESS']),
}).strict();

export type CheckoutInput = z.infer<typeof checkoutBodySchema>;
