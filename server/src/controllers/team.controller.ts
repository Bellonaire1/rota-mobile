import { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';
import { ListTeamMembersQuery } from '../schemas/team.schema';

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

  async listMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        ...(await teamService.listMembers(
          req.params.teamId,
          req.query as unknown as ListTeamMembersQuery
        )),
      });
    } catch (error) {
      next(error);
    }
  },

  async addMember(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json({
        member: await teamService.addMember(
          req.params.teamId,
          req.auth!.userId,
          req.body
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async updateMemberRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        member: await teamService.updateMemberRole(
          req.params.teamId,
          req.auth!.userId,
          req.params.userId,
          req.body
        ),
      });
    } catch (error) {
      next(error);
    }
  },

  async removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await teamService.removeMember(
        req.params.teamId,
        req.auth!.userId,
        req.params.userId
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
};
