import { app } from './app';
import { env } from './config/env';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[Rota Server] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
  console.log(`[Rota Server] Health check available at: http://localhost:${env.PORT}/api/v1/health`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('[Rota Server] Received termination signal. Closing server...');
  server.close(() => {
    console.log('[Rota Server] Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default server;
