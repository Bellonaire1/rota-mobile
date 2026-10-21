import { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';

export const teamController = {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json({
        team: await teamService.create(req.body, req.auth!.userId),
      });
    } catch (error) {
      next(error);
    }
  },

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        teams: await teamService.listForUser(req.auth!.userId),
      });
    } catch (error) {
      next(error);
    }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        team: await teamService.getForUser(req.params.id, req.auth!.userId),
      });
    } catch (error) {
      next(error);
    }
  },
};
