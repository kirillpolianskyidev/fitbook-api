import {logger} from '../lib/logger.js';

type Job = {name: string; everyMs: number; run: () => Promise<unknown>};

const jobs: Job[] = [];

export function registerJob(job: Job) {
  jobs.push(job);
}

export function startJobs() {
  const timers = jobs.map(job =>
    setInterval(() => {
      job.run().catch(error => logger.error({err: error, job: job.name}, 'Job failed'));
    }, job.everyMs),
  );
  return () => timers.forEach(clearInterval);
}
