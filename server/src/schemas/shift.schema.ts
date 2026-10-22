import { ShiftStatus } from '@prisma/client';
import { z } from 'zod';

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: 'Timestamp must be ISO 8601 with an explicit UTC offset' })
  .transform((value) => new Date(value));

const shiftStatusSchema = z.nativeEnum(ShiftStatus);

const validateTimeRange = <T extends { startsAt: Date; endsAt: Date }>(value: T, ctx: z.RefinementCtx) => {
  if (value.startsAt >= value.endsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'Shift end must be after shift start',
    });
  }
  if (value.endsAt.getTime() - value.startsAt.getTime() > 24 * 60 * 60 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'Shift duration must not exceed 24 hours',
    });
  }
};

export const shiftParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
});

export const shiftTargetParamsSchema = z.object({
  teamId: z.string().uuid({ message: 'Invalid team ID format, expected UUID' }),
  shiftId: z.string().uuid({ message: 'Invalid shift ID format, expected UUID' }),
});

export const shiftListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  status: shiftStatusSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from >= value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The end of the date range must be after its start',
    });
  }
});

export const createShiftSchema = z.object({
  title: z.string().trim().min(1, 'Shift title is required').max(200),
  assignedToUserId: z.string().uuid({ message: 'Invalid user ID format, expected UUID' }),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
}).superRefine(validateTimeRange);

export const updateShiftSchema = z.object({
  title: z.string().trim().min(1, 'Shift title is required').max(200).optional(),
  assignedToUserId: z.string().uuid({ message: 'Invalid user ID format, expected UUID' }).optional(),
  startsAt: isoDateTimeSchema.optional(),
  endsAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema,
}).refine(
  ({ title, assignedToUserId, startsAt, endsAt }) =>
    title !== undefined || assignedToUserId !== undefined || startsAt !== undefined || endsAt !== undefined,
  { message: 'At least one shift field must be updated' }
);

export const cancelShiftSchema = z.object({
  updatedAt: isoDateTimeSchema,
});

export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type CancelShiftInput = z.infer<typeof cancelShiftSchema>;
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;
