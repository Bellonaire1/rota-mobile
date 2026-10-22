import { Request, Response, NextFunction } from 'express';
import { shiftService } from '../services/shift.service';
import {
  CancelShiftInput,
  CreateShiftInput,
  ShiftListQuery,
  UpdateShiftInput,
} from '../schemas/shift.schema';

export const shiftController = {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json({
        shift: await shiftService.create(
          req.params.teamId,
          req.auth!.userId,
          req.body as CreateShiftInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        ...(await shiftService.list(
          req.params.teamId,
          req.query as unknown as ShiftListQuery
        )),
      });
    } catch (error) {
      next(error);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        shift: await shiftService.update(
          req.params.teamId,
          req.params.shiftId,
          req.auth!.userId,
          req.body as UpdateShiftInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        shift: await shiftService.cancel(
          req.params.teamId,
          req.params.shiftId,
          req.auth!.userId,
          req.body as CancelShiftInput
        ),
      });
    } catch (error) {
      next(error);
    }
  },
};
