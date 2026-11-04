import { z } from 'zod';

export const activityFeedParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
});

export const activityFeedQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100, 'Limit cannot exceed 100').default(20),
  cursor: z.string().trim().min(1, 'Cursor cannot be empty').optional(),
});

export type ActivityFeedParams = z.infer<typeof activityFeedParamsSchema>;
export type ActivityFeedQuery = z.infer<typeof activityFeedQuerySchema>;
