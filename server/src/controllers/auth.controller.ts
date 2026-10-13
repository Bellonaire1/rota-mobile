import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

const refreshTokenFromBody = (req: Request): string => req.body.refreshToken;

export const authController = {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json(await authService.register(req.body));
    } catch (error) {
      next(error);
    }
  },

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json(await authService.login(req.body));
    } catch (error) {
      next(error);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json(await authService.refresh(refreshTokenFromBody(req)));
    } catch (error) {
      next(error);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.logout(refreshTokenFromBody(req));
      res.status(200).json({ message: 'Logged out' });
    } catch (error) {
      next(error);
    }
  },

  async logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.logoutAll(req.auth!.userId);
      res.status(200).json({ message: 'All sessions logged out' });
    } catch (error) {
      next(error);
    }
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ user: await authService.getSafeUser(req.auth!.userId) });
    } catch (error) {
      next(error);
    }
  },
};
