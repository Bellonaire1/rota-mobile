import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';

export interface AccessTokenClaims {
  userId: string;
}

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const createRefreshToken = (): string =>
  randomBytes(48).toString('base64url');

export const createFamilyId = (): string => randomBytes(24).toString('hex');

export const createAccessToken = (userId: string): string =>
  jwt.sign({ typ: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  });

export const verifyAccessToken = (token: string): AccessTokenClaims => {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    });

    if (
      typeof decoded === 'string' ||
      decoded.typ !== 'access' ||
      typeof decoded.sub !== 'string'
    ) {
      throw new Error('Invalid access token claims');
    }

    return { userId: decoded.sub };
  } catch {
    throw new AppError(401, 'Invalid or expired access token');
  }
};
