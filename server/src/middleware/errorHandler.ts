import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const parserError = err as Error & { status?: number; type?: string };
  if (parserError.type === 'entity.too.large') {
    res.status(413).json({ status: 'error', message: 'Request body is too large' });
    return;
  }
  if (parserError.type === 'entity.parse.failed') {
    res.status(400).json({ status: 'error', message: 'Malformed JSON body' });
    return;
  }

  if (!(err instanceof AppError)) {
    console.error('Unhandled server error:', err);
  }

  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message = err instanceof AppError ? err.message : 'Internal server error';
  
  res.status(statusCode).json({
    status: 'error',
    message,
  });
};
