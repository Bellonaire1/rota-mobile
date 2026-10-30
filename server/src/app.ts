import express, { Application, Request } from 'express';
import cors from 'cors';
import apiRouter from './routes';
import { notFoundHandler } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';

export const createApp = (): Application => {
  const app = express();

  // Trust first proxy hop (Render / reverse proxy TLS termination)
  app.set('trust proxy', 1);

  // Middleware
  app.use(cors());
  app.use('/api/v1/billing/webhooks/paystack', express.raw({
    limit: '100kb',
    type: 'application/json',
  }), (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) (req as Request).rawBody = Buffer.from(req.body);
    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API v1 Routes
  app.use('/api/v1', apiRouter);

  // Fallback handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export const app = createApp();
export default app;
