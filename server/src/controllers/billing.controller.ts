import { Request, Response, NextFunction } from 'express';
import { billingService } from '../services/billing.service';
import { paystackWebhookService } from '../services/paystack-webhook.service';

export const billingController = {
  async plans(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.status(200).json({ plans: await billingService.listPlans() }); } catch (error) { next(error); }
  },
  async teamBilling(req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.status(200).json({ billing: await billingService.getTeamBilling(req.params.teamId, req.auth!.userId) }); } catch (error) { next(error); }
  },
  async checkout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await billingService.checkout(req.params.teamId, req.auth!.userId, req.body, req.header('Idempotency-Key'));
      res.status(result.statusCode).json({ checkout: result });
    } catch (error) { next(error); }
  },
  async paystackWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await paystackWebhookService.receive(req.rawBody, req.header('x-paystack-signature'));
      res.status(200).json({ status: 'ok' });
    } catch (error) { next(error); }
  },
};
