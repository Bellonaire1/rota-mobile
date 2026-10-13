import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';
import { verifyAccessToken } from '../auth/tokens';

export const authenticate = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const header = req.header('authorization');
  const [scheme, token] = header?.split(' ') ?? [];

  if (scheme !== 'Bearer' || !token) {
    next(new AppError(401, 'Authentication required'));
    return;
  }

  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (error) {
    next(error);
  }
};
