import { buildApp } from './app.js';
import { env, hasRequiredSecrets } from './config/env.js';
import { prisma } from './config/prisma.js';
import { startBackgroundJobs } from './jobs/runner.js';

if (!hasRequiredSecrets) {
  console.error(
    'FATAL: One or more required secrets are missing.\n' +
    'Set JWT_SECRET, JWT_REFRESH_SECRET, and CREDENTIAL_ENCRYPTION_KEY before starting the server.'
  );
  process.exit(1);
}

const app = buildApp();
const jobs = startBackgroundJobs(app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutdown signal received');
  try {
    jobs.stop();
    await app.close();
    app.log.info('HTTP server closed');
    await prisma.$disconnect();
    app.log.info('Database disconnected');
    app.log.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed');
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const start = async () => {
  try {
    await app.listen({
      host: '0.0.0.0',
      port: env.PORT
    });
  } catch (error) {
    app.log.error(error, 'Failed to start server');
    process.exit(1);
  }
};

void start();
