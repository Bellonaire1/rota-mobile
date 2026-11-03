import { ShiftSwapStatus } from '@prisma/client';
import { z } from 'zod';

export const shiftSwapParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
});

export const shiftSwapTargetParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
  swapId: z.string().uuid({ message: 'Invalid swap ID format, expected UUID' }),
});

export const shiftSwapListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.nativeEnum(ShiftSwapStatus).optional(),
});

export const createShiftSwapSchema = z
  .object({
    sourceShiftId: z.string().uuid({ message: 'Invalid source shift ID format, expected UUID' }),
    targetShiftId: z.string().uuid({ message: 'Invalid target shift ID format, expected UUID' }),
  })
  .refine((data) => data.sourceShiftId !== data.targetShiftId, {
    message: 'Source and target shifts must be different',
    path: ['targetShiftId'],
  });

export const respondShiftSwapSchema = z.object({
  action: z.enum(['accept', 'decline'], {
    errorMap: () => ({ message: 'Action must be either accept or decline' }),
  }),
});

export const reviewShiftSwapSchema = z.object({
  action: z.enum(['approve', 'reject'], {
    errorMap: () => ({ message: 'Action must be either approve or reject' }),
  }),
  reason: z.string().trim().max(500, 'Rejection reason must not exceed 500 characters').optional(),
});

export type CreateShiftSwapInput = z.infer<typeof createShiftSwapSchema>;
export type RespondShiftSwapInput = z.infer<typeof respondShiftSwapSchema>;
export type ReviewShiftSwapInput = z.infer<typeof reviewShiftSwapSchema>;
export type ShiftSwapListQuery = z.infer<typeof shiftSwapListQuerySchema>;

