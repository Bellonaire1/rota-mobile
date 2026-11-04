import { Request, Response, NextFunction } from 'express';
import { teamInvitationService } from '../services/team-invitation.service';

export const teamInvitationController = {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invitation = await teamInvitationService.create(
        req.params.teamId,
        req.auth!.userId,
        req.body
      );
      res.status(201).json({ invitation });
    } catch (error) {
      next(error);
    }
  },

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invitations = await teamInvitationService.list(
        req.params.teamId,
        req.auth!.userId
      );
      res.status(200).json({ invitations });
    } catch (error) {
      next(error);
    }
  },

  async revoke(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invitation = await teamInvitationService.revoke(
        req.params.teamId,
        req.params.invitationId,
        req.auth!.userId
      );
      res.status(200).json({ invitation });
    } catch (error) {
      next(error);
    }
  },

  async preview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invitation = await teamInvitationService.preview(
        req.body.token,
        req.auth!.userId
      );
      res.status(200).json({ invitation });
    } catch (error) {
      next(error);
    }
  },

  async accept(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await teamInvitationService.accept(
        req.body.token,
        req.auth!.userId
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
};
