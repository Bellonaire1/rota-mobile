import express, { Application } from 'express';
import cors from 'cors';
import apiRouter from './routes';
import { notFoundHandler } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';

export const createApp = (): Application => {
  const app = express();

  // Middleware
  app.use(cors());
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
