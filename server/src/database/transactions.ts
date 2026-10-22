import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const SERIALIZABLE_RETRIES = 3;

export const runSerializable = async <T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
): Promise<T> => {
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034' ||
        attempt === SERIALIZABLE_RETRIES
      ) {
        throw error;
      }
    }
  }

  throw new Error('Serializable transaction retry limit exceeded');
};
