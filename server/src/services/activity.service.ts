import { ActivityEvent, ActivityEventType, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AppError } from '../errors/AppError';
import { ActivityFeedQuery } from '../schemas/activity.schema';

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(event: { createdAt: Date; id: string }): string {
  const payload = {
    createdAt: event.createdAt.toISOString(),
    id: event.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursorStr: string): DecodedCursor {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid cursor payload');
    }
    const { createdAt, id } = parsed;
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Invalid cursor id');
    }
    const date = new Date(createdAt);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid cursor timestamp');
    }
    return { createdAt: date, id };
  } catch {
    throw new AppError(400, 'Invalid pagination cursor');
  }
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'jwt',
  'authorization',
  'creditcard',
  'cvv',
  'apikey',
]);

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  const stripped = lower.replace(/[-_]/g, '');
  return SENSITIVE_KEYS.has(stripped);
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== 'function')
      .map((item) => sanitizeValue(item));
  }
  const cleanObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      continue;
    }
    if (v !== undefined && typeof v !== 'function') {
      cleanObj[k] = sanitizeValue(v);
    }
  }
  return cleanObj;
}

export function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(metadata)) {
    if (isSensitiveKey(key)) continue;
    if (val !== undefined && typeof val !== 'function') {
      sanitized[key] = sanitizeValue(val);
    }
  }
  return sanitized;
}

export interface LogActivityEventInput {
  teamId: string;
  actorUserId?: string | null;
  type: ActivityEventType;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityFeedResponse {
  events: (ActivityEvent & {
    actor: { id: string; name: string | null; email: string } | null;
  })[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export const activityService = {
  async logEvent(
    tx: Prisma.TransactionClient,
    input: LogActivityEventInput
  ): Promise<ActivityEvent> {
    const cleanMeta = sanitizeMetadata(input.metadata);
    return tx.activityEvent.create({
      data: {
        teamId: input.teamId,
        actorUserId: input.actorUserId ?? null,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: cleanMeta as Prisma.InputJsonValue,
      },
    });
  },

  async list(
    teamId: string,
    query: ActivityFeedQuery
  ): Promise<ActivityFeedResponse> {
    const limit = query.limit ?? 20;
    let cursor: DecodedCursor | null = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
    }

    const where: Prisma.ActivityEventWhereInput = {
      teamId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const records = await prisma.activityEvent.findMany({
      where,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const hasMore = records.length > limit;
    const events = hasMore ? records.slice(0, limit) : records;
    const lastItem = events.length > 0 ? events[events.length - 1] : null;
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;

    return {
      events,
      pagination: {
        limit,
        hasMore,
        nextCursor,
      },
    };
  },
};
