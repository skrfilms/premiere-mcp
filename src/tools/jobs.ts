/**
 * Background jobs: run a slow tool without holding the client's request open.
 *
 * Exports, transcription, stems and renders routinely outlive a client's tool-call timeout
 * (60 s is common), and a timed-out call is the start of the doubled-edit failure the journal
 * exists for. `start_job` returns a job id at once; `get_job` reports progress and, when done,
 * the tool's own result. Jobs live in this server process: a restart loses the job table (the
 * journal still records whether the underlying call finished).
 */
import { randomUUID } from 'node:crypto';

export interface Job {
  jobId: string;
  tool: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, Job>();
const MAX_JOBS = 100;

export function startJob(tool: string, run: () => Promise<unknown>): Job {
  const job: Job = {
    jobId: randomUUID(),
    tool,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  if (jobs.size > MAX_JOBS) {
    const oldestDone = [...jobs.values()].find((j) => j.status !== 'running');
    if (oldestDone) jobs.delete(oldestDone.jobId);
  }
  run().then(
    (result) => {
      const failed = !!(
        result &&
        typeof result === 'object' &&
        (result as { success?: unknown }).success === false
      );
      Object.assign(job, {
        status: failed ? 'failed' : 'done',
        finishedAt: new Date().toISOString(),
        result,
      });
    },
    (e) =>
      Object.assign(job, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      }),
  );
  return job;
}

export function getJob(jobId: string): (Job & { elapsedSeconds: number }) | undefined {
  const j = jobs.get(jobId);
  if (!j) return undefined;
  const end = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
  return { ...j, elapsedSeconds: Math.round((end - Date.parse(j.startedAt)) / 100) / 10 };
}

export function listJobs(): Array<Omit<Job, 'result'> & { elapsedSeconds: number }> {
  return [...jobs.values()].reverse().map((j) => {
    const { result: _r, ...rest } = getJob(j.jobId)!;
    return rest;
  });
}
