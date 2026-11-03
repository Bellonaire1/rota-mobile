import { Request, Response, NextFunction } from 'express';
import { shiftSwapService } from '../services/shift-swap.service';
import {
  CreateShiftSwapInput,
  RespondShiftSwapInput,
  ReviewShiftSwapInput,
  ShiftSwapListQuery,
} from '../schemas/shift-swap.schema';

export const shiftSwapController = {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json({
        shiftSwap: await shiftSwapService.create(
          req.params.teamId,
          req.auth!.userId,
          req.body as CreateShiftSwapInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        ...(await shiftSwapService.list(
          req.params.teamId,
          req.auth!.userId,
          req.teamMembership!.role,
          req.query as unknown as ShiftSwapListQuery
        )),
      });
    } catch (error) {
      next(error);
    }
  },

  async respond(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        shiftSwap: await shiftSwapService.respond(
          req.params.teamId,
          req.params.swapId,
          req.auth!.userId,
          req.body as RespondShiftSwapInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async review(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        shiftSwap: await shiftSwapService.review(
          req.params.teamId,
          req.params.swapId,
          req.auth!.userId,
          req.body as ReviewShiftSwapInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        shiftSwap: await shiftSwapService.cancel(
          req.params.teamId,
          req.params.swapId,
          req.auth!.userId
        ),
      });
    } catch (error) {
      next(error);
    }
  },
};

