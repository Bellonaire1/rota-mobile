import bcrypt from 'bcryptjs';
import { Prisma, User } from '@prisma/client';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';
import {
  createAccessToken,
  createFamilyId,
  createRefreshToken,
  hashRefreshToken,
} from '../auth/tokens';
import { LoginInput, RegisterInput } from '../schemas/auth.schema';

const PASSWORD_HASH_ROUNDS = 12;
const DUMMY_PASSWORD_HASH =
  '$2b$12$mGX9iu2Lwu9a.7hjCNrC/OA9txTf6A5twVjoNx53i7w5oPte4iCJy';

const safeUserSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Pick<
  User,
  'id' | 'email' | 'name' | 'createdAt' | 'updatedAt'
>;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends TokenPair {
  user: SafeUser;
}

const invalidCredentials = (): never => {
  throw new AppError(401, 'Invalid email or password');
};

const createSession = async (
  userId: string,
  familyId = createFamilyId()
): Promise<{ refreshToken: string; familyId: string }> => {
  const refreshToken = createRefreshToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      expiresAt,
    },
  });

  return { refreshToken, familyId };
};

const issueAuthResult = async (user: SafeUser): Promise<AuthResult> => {
  const { refreshToken } = await createSession(user.id);

  return {
    user,
    accessToken: createAccessToken(user.id),
    refreshToken,
  };
};

export const authService = {
  async register(input: RegisterInput): Promise<AuthResult> {
    const passwordHash = await bcrypt.hash(input.password, PASSWORD_HASH_ROUNDS);

    try {
      const user = await prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
        },
        select: safeUserSelect,
      });

      return issueAuthResult(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(409, 'An account with that email already exists');
      }
      throw error;
    }
  },

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
    });
    const passwordMatches = await bcrypt.compare(
      input.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH
    );

    if (!user || !passwordMatches) {
      return invalidCredentials();
    }

    const safeUser: SafeUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    return issueAuthResult(safeUser);
  },

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);
    const now = new Date();

    return prisma.$transaction(async (transaction) => {
      const session = await transaction.authSession.findUnique({
        where: { tokenHash },
      });

      if (!session) {
        throw new AppError(401, 'Invalid refresh token');
      }

      if (session.usedAt || session.revokedAt) {
        await transaction.authSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { error: 'Refresh token reuse detected' };
      }

      if (session.expiresAt <= now) {
        await transaction.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
        return { error: 'Invalid refresh token' };
      }

      const claimed = await transaction.authSession.updateMany({
        where: { id: session.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });

      if (claimed.count !== 1) {
        await transaction.authSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { error: 'Refresh token reuse detected' };
      }

      const nextRefreshToken = createRefreshToken();
      await transaction.authSession.create({
        data: {
          userId: session.userId,
          tokenHash: hashRefreshToken(nextRefreshToken),
          familyId: session.familyId,
          expiresAt: new Date(
            now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
          ),
        },
      });

      return {
        accessToken: createAccessToken(session.userId),
        refreshToken: nextRefreshToken,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).then((result) => {
      if ('error' in result) {
        throw new AppError(401, result.error ?? 'Invalid refresh token');
      }
      return result;
    });
  },

  async logout(refreshToken: string): Promise<void> {
    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
    });

    if (!session) {
      throw new AppError(401, 'Invalid refresh token');
    }

    await prisma.authSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async logoutAll(userId: string): Promise<void> {
    await prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async getSafeUser(userId: string): Promise<SafeUser> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: safeUserSelect,
    });

    if (!user) {
      throw new AppError(401, 'Authenticated user no longer exists');
    }

    return user;
  },
};
