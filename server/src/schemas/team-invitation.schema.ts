import { z } from 'zod';
import { TeamRole } from '@prisma/client';

export const allowedInvitationRoleSchema = z.union([
  z.literal(TeamRole.STAFF),
  z.literal(TeamRole.MANAGER),
]);

export const createInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address')
    .max(255)
    .transform((val) => val.toLowerCase()),
  role: allowedInvitationRoleSchema,
  clientBaseUrl: z.string().trim().max(1024).optional(),
});

export const teamInvitationParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
});

export const teamInvitationTargetParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
  invitationId: z.string().uuid({ message: 'Invalid invitation ID format, expected UUID' }),
});

export const tokenActionSchema = z.object({
  token: z
    .string()
    .trim()
    .min(16, 'Invalid token length')
    .max(256, 'Invalid token length'),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type TeamInvitationParams = z.infer<typeof teamInvitationParamsSchema>;
export type TeamInvitationTargetParams = z.infer<typeof teamInvitationTargetParamsSchema>;
export type TokenActionInput = z.infer<typeof tokenActionSchema>;
