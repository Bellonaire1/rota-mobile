import { z } from 'zod';
import { TeamRole } from '@prisma/client';

export const createTeamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(100),
});

export const teamIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Invalid ID format, expected UUID' }),
});

const teamMemberRoleSchema = z.union([
  z.literal(TeamRole.STAFF),
  z.literal(TeamRole.MANAGER),
]);

export const teamMemberParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
});

export const teamMemberTargetParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
  userId: z.string().uuid({ message: 'Invalid user ID format, expected UUID' }),
});

export const listTeamMembersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid({ message: 'Invalid user ID format, expected UUID' }),
  role: teamMemberRoleSchema.default(TeamRole.STAFF),
});

export const updateTeamMemberRoleSchema = z.object({
  role: teamMemberRoleSchema,
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
export type ListTeamMembersQuery = z.infer<typeof listTeamMembersQuerySchema>;
