import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(100),
});

export const teamIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Invalid ID format, expected UUID' }),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
