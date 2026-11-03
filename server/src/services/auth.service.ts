import bcrypt from 'bcryptjs';
import { Prisma, User } from '@prisma/client';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';
import {
  createAccessToken,
  createFamilyId,
  createRefreshToken,
  createPasswordResetToken,
  hashPasswordResetToken,
  createMagicLinkToken,
  hashMagicLinkToken,
  hashRefreshToken,
} from '../auth/tokens';
import {
  LoginInput,
  MagicLinkConfirmInput,
  MagicLinkRequestInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RegisterInput,
} from '../schemas/auth.schema';
import { emailService } from './email';

const PASSWORD_HASH_ROUNDS = 12;
const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_RESET_REQUESTS_PER_WINDOW = 3;
const GENERIC_RESET_REQUEST_MESSAGE =
  'If an account exists with that email, a password reset link has been sent.';
const GENERIC_RESET_SUCCESS_MESSAGE =
  'Password has been reset successfully. Please log in with your new password.';
const MAGIC_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAGIC_LINK_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_MAGIC_LINK_REQUESTS_PER_WINDOW = 3;
const GENERIC_MAGIC_LINK_REQUEST_MESSAGE =
  'If an account exists with that email, a sign-in link has been sent.';
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

  async requestPasswordReset(
    input: PasswordResetRequestInput,
    clientBaseUrl?: string
  ): Promise<{ message: string }> {
    // 1. Verify email delivery provider is configured and operational
    try {
      await emailService.verifyDeliveryAvailable();
    } catch {
      throw new AppError(500, 'Unable to send password reset email at this time');
    }

    // 2. Persistent database-backed atomic throttling across all emails (known and unknown)
    const windowStart = new Date(Date.now() - RESET_REQUEST_WINDOW_MS);
    try {
      await prisma.$transaction(async (tx) => {
        // Linearize concurrent requests for the same normalized email using an advisory lock
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.email}))`;

        const recentRequestsCount = await tx.passwordResetRequest.count({
          where: {
            email: input.email,
            createdAt: { gte: windowStart },
          },
        });

        if (recentRequestsCount >= MAX_RESET_REQUESTS_PER_WINDOW) {
          throw new AppError(429, 'Too many password reset requests. Please try again later.');
        }

        await tx.passwordResetRequest.create({
          data: {
            email: input.email,
          },
        });
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2002')
      ) {
        throw new AppError(429, 'Too many password reset requests. Please try again later.');
      }
      throw error;
    }

    // 3. User lookup
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user) {
      // Constant-time dummy work to mitigate timing attacks
      await bcrypt.compare(input.email, DUMMY_PASSWORD_HASH);
      return { message: GENERIC_RESET_REQUEST_MESSAGE };
    }

    // 4. Generate secure token for existing user
    const rawToken = createPasswordResetToken();
    const tokenHash = hashPasswordResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

    const tokenRecord = await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    try {
      await emailService.sendPasswordResetEmail({
        to: user.email,
        resetToken: rawToken,
        clientBaseUrl,
      });
    } catch (error) {
      // 1. Clean up unused token so no orphaned, unreceived token lingers in DB
      await prisma.passwordResetToken.delete({ where: { id: tokenRecord.id } }).catch(() => {});

      // 2. Alert internal monitoring (never silently swallow failure for operations)
      console.error(
        `[AuthService] Password reset email dispatch failed for user ${user.id}:`,
        error
      );

      // 3. Return the neutral conditional response to prevent external account enumeration
      // Note: requestRecord is deliberately preserved to maintain rate limiting against failing downstream gateways
      return { message: GENERIC_RESET_REQUEST_MESSAGE };
    }

    return { message: GENERIC_RESET_REQUEST_MESSAGE };
  },

  async confirmPasswordReset(
    input: PasswordResetConfirmInput
  ): Promise<{ message: string }> {
    const tokenHash = hashPasswordResetToken(input.token);

    try {
      return await prisma.$transaction(async (tx) => {
      const tokenRecord = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      if (!tokenRecord) {
        throw new AppError(400, 'Invalid or expired password reset token');
      }

      if (tokenRecord.usedAt) {
        throw new AppError(400, 'Password reset token has already been used');
      }

      const now = new Date();
      if (tokenRecord.expiresAt <= now) {
        throw new AppError(400, 'Password reset token has expired');
      }

      const claim = await tx.passwordResetToken.updateMany({
        where: {
          id: tokenRecord.id,
          usedAt: null,
        },
        data: {
          usedAt: now,
        },
      });

      if (claim.count !== 1) {
        throw new AppError(400, 'Password reset token has already been used');
      }

      const passwordHash = await bcrypt.hash(input.password, PASSWORD_HASH_ROUNDS);

      await tx.user.update({
        where: { id: tokenRecord.userId },
        data: { passwordHash },
      });

      await tx.authSession.updateMany({
        where: {
          userId: tokenRecord.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });

      return { message: GENERIC_RESET_SUCCESS_MESSAGE };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new AppError(400, 'Password reset token has already been used');
      }
      throw error;
    }
  },

  async requestMagicLink(
    input: MagicLinkRequestInput,
    clientBaseUrl?: string
  ): Promise<{ message: string }> {
    // 1. Verify email delivery provider is configured and operational
    try {
      await emailService.verifyDeliveryAvailable();
    } catch {
      throw new AppError(500, 'Unable to send magic link email at this time');
    }

    // 2. Persistent database-backed atomic throttling across all emails (known and unknown)
    const windowStart = new Date(Date.now() - MAGIC_LINK_REQUEST_WINDOW_MS);
    try {
      await prisma.$transaction(async (tx) => {
        // Linearize concurrent requests for the same normalized email using an advisory lock
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.email}))`;

        const recentRequestsCount = await tx.magicLinkRequest.count({
          where: {
            email: input.email,
            createdAt: { gte: windowStart },
          },
        });

        if (recentRequestsCount >= MAX_MAGIC_LINK_REQUESTS_PER_WINDOW) {
          throw new AppError(429, 'Too many magic link requests. Please try again later.');
        }

        await tx.magicLinkRequest.create({
          data: {
            email: input.email,
          },
        });
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2002')
      ) {
        throw new AppError(429, 'Too many magic link requests. Please try again later.');
      }
      throw error;
    }

    // 3. User lookup - only send sign-in links to existing accounts
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user) {
      // Constant-time dummy work to mitigate timing attacks
      await bcrypt.compare(input.email, DUMMY_PASSWORD_HASH);
      return { message: GENERIC_MAGIC_LINK_REQUEST_MESSAGE };
    }

    // 4. Generate secure token for existing user
    const rawToken = createMagicLinkToken();
    const tokenHash = hashMagicLinkToken(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TOKEN_TTL_MS);

    const tokenRecord = await prisma.magicLinkToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    try {
      await emailService.sendMagicLinkEmail({
        to: user.email,
        token: rawToken,
        clientBaseUrl,
      });
    } catch (error) {
      // Clean up unused token so no orphaned, unreceived token lingers in DB
      await prisma.magicLinkToken.delete({ where: { id: tokenRecord.id } }).catch(() => {});

      // Alert internal monitoring
      console.error(
        `[AuthService] Magic link email dispatch failed for user ${user.id}:`,
        error
      );

      // Return neutral conditional response to prevent external account enumeration
      return { message: GENERIC_MAGIC_LINK_REQUEST_MESSAGE };
    }

    return { message: GENERIC_MAGIC_LINK_REQUEST_MESSAGE };
  },

  async confirmMagicLink(
    input: MagicLinkConfirmInput
  ): Promise<AuthResult> {
    const tokenHash = hashMagicLinkToken(input.token);

    try {
      return await prisma.$transaction(async (tx) => {
        const tokenRecord = await tx.magicLinkToken.findUnique({
          where: { tokenHash },
        });

        if (!tokenRecord) {
          throw new AppError(400, 'Invalid or expired magic link token');
        }

        if (tokenRecord.usedAt) {
          throw new AppError(400, 'Magic link token has already been used');
        }

        const now = new Date();
        if (tokenRecord.expiresAt <= now) {
          throw new AppError(400, 'Magic link token has expired');
        }

        const claim = await tx.magicLinkToken.updateMany({
          where: {
            id: tokenRecord.id,
            usedAt: null,
          },
          data: {
            usedAt: now,
          },
        });

        if (claim.count !== 1) {
          throw new AppError(400, 'Magic link token has already been used');
        }

        const user = await tx.user.findUnique({
          where: { id: tokenRecord.userId },
          select: safeUserSelect,
        });

        if (!user) {
          throw new AppError(401, 'User account no longer exists');
        }

        // Create a new session for the authenticated user
        const refreshToken = createRefreshToken();
        const familyId = createFamilyId();
        const expiresAt = new Date(
          now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
        );

        await tx.authSession.create({
          data: {
            userId: user.id,
            tokenHash: hashRefreshToken(refreshToken),
            familyId,
            expiresAt,
          },
        });

        return {
          user,
          accessToken: createAccessToken(user.id),
          refreshToken,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new AppError(400, 'Magic link token has already been used');
      }
      throw error;
    }
  },
};
