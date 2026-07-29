import { useState, useCallback } from 'react';
import { AsyncJobTracker, type AsyncJob } from '../../../custom/async-job-tracker';

export function PendingTracker() {
  return <AsyncJobTracker jobId="job-pending" pollFn={async (id) => ({ jobId: id, status: 'pending' })} pollIntervalMs={60000} />;
}

export function ProcessingTracker() {
  return (
    <AsyncJobTracker
      jobId="job-processing"
      pollFn={async (id) => ({
        jobId: id,
        status: 'processing',
        progress: 45,
        estimatedMs: 10000,
      })}
      pollIntervalMs={60000}
    />
  );
}

export function CompletedTracker() {
  return (
    <AsyncJobTracker
      jobId="job-completed"
      pollFn={async (id) => ({
        jobId: id,
        status: 'completed',
        progress: 100,
        result: { output: 'done' },
      })}
      pollIntervalMs={60000}
    />
  );
}

export function FailedTracker() {
  return (
    <AsyncJobTracker
      jobId="job-failed"
      pollFn={async (id) => ({
        jobId: id,
        status: 'failed',
        error: 'Connection timed out',
      })}
      pollIntervalMs={60000}
    />
  );
}

export function NullJobTracker() {
  return <AsyncJobTracker jobId={null} pollFn={async (id) => ({ jobId: id, status: 'pending' })} />;
}

export function CallbackTracker({ onComplete, onError }: { onComplete?: (result: unknown) => void; onError?: (error: string) => void }) {
  const pollFn = useCallback(
    async (id: string): Promise<AsyncJob> => ({
      jobId: id,
      status: 'completed',
      result: { data: 'test-result' },
    }),
    [],
  );

  return <AsyncJobTracker jobId="job-callback" pollFn={pollFn} pollIntervalMs={500} onComplete={onComplete} onError={onError} />;
}

export function StartStopTracker() {
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <div>
      <button data-testid="start-btn" onClick={() => setJobId('job-dynamic')}>
        Start
      </button>
      <button data-testid="stop-btn" onClick={() => setJobId(null)}>
        Stop
      </button>
      <AsyncJobTracker
        jobId={jobId}
        pollFn={async (id) => ({
          jobId: id,
          status: 'processing',
          progress: 50,
        })}
        pollIntervalMs={60000}
      />
    </div>
  );
}
