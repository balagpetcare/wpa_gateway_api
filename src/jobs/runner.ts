import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { runCallbackRetryJob } from './tasks/callback-retry.js';
import { runPayoutStaleReviewJob } from './tasks/payout-stale-review.js';
import { runSessionExpiryJob } from './tasks/session-expiry.js';

type JobHandler = () => Promise<{ processed: number }>;

type RunningJob = {
  name: string;
  stop: () => void;
};

const startIntervalJob = (input: {
  name: string;
  intervalMs: number;
  logger: FastifyBaseLogger;
  handler: JobHandler;
}): RunningJob => {
  let running = false;

  const execute = async () => {
    if (running) {
      input.logger.warn({ job: input.name }, 'Skipping job tick because previous run is still in progress');
      return;
    }

    running = true;
    try {
      const result = await input.handler();
      input.logger.info({ job: input.name, processed: result.processed }, 'Background job run completed');
    } catch (error) {
      input.logger.error({ err: error, job: input.name }, 'Background job run failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void execute();
  }, input.intervalMs);
  timer.unref();

  void execute();

  input.logger.info({ job: input.name, intervalSeconds: Math.floor(input.intervalMs / 1000) }, 'Background job started');

  return {
    name: input.name,
    stop: () => clearInterval(timer)
  };
};

export const startBackgroundJobs = (logger: FastifyBaseLogger) => {
  if (env.BACKGROUND_JOBS_ENABLED !== 'true') {
    logger.info('Background jobs disabled by configuration');
    return {
      stop: () => undefined
    };
  }

  const jobs: RunningJob[] = [];

  if (env.JOB_SESSION_EXPIRY_ENABLED === 'true') {
    jobs.push(
      startIntervalJob({
        name: 'session-expiry',
        intervalMs: env.JOB_SESSION_EXPIRY_INTERVAL_SECONDS * 1000,
        logger,
        handler: () => runSessionExpiryJob(logger)
      })
    );
  }

  if (env.JOB_CALLBACK_RETRY_ENABLED === 'true') {
    jobs.push(
      startIntervalJob({
        name: 'callback-retry',
        intervalMs: env.JOB_CALLBACK_RETRY_INTERVAL_SECONDS * 1000,
        logger,
        handler: () =>
          runCallbackRetryJob(logger, {
            maxAttempts: env.JOB_CALLBACK_RETRY_MAX_ATTEMPTS,
            baseDelaySeconds: env.JOB_CALLBACK_RETRY_INTERVAL_SECONDS
          })
      })
    );
  }

  if (env.JOB_PAYOUT_STALE_REVIEW_ENABLED === 'true') {
    jobs.push(
      startIntervalJob({
        name: 'payout-stale-review',
        intervalMs: env.JOB_PAYOUT_STALE_REVIEW_INTERVAL_SECONDS * 1000,
        logger,
        handler: () => runPayoutStaleReviewJob(logger, { staleHours: env.JOB_PAYOUT_STALE_HOURS })
      })
    );
  }

  logger.info(
    {
      jobs: jobs.map((job) => job.name)
    },
    'Background jobs enabled'
  );

  return {
    stop: () => {
      for (const job of jobs) {
        job.stop();
      }
      logger.info({ jobs: jobs.map((job) => job.name) }, 'Background jobs stopped');
    }
  };
};
