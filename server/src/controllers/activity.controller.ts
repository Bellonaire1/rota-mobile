import { Request, Response, NextFunction } from 'express';
import { activityService } from '../services/activity.service';
import { ActivityFeedQuery } from '../schemas/activity.schema';

export const activityController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const feed = await activityService.list(
        req.params.teamId,
        req.query as unknown as ActivityFeedQuery
      );
      res.status(200).json(feed);
    } catch (error) {
      next(error);
    }
  },
};
