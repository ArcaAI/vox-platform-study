import { NotFoundException, type MessageEvent } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Observable } from 'rxjs';
import type { DnaJobStatusResponseDto } from './dna-writing-style.dto';

type BullMQJobState = 'completed' | 'failed' | 'active' | 'delayed' | 'waiting' | 'waiting-children' | 'prioritized' | 'unknown';

export function mapBullStateToDnaStatus(state: BullMQJobState): 'queued' | 'processing' | 'completed' | 'failed' {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'processing';
    default:
      return 'queued';
  }
}

function toProgress(progress: Job['progress'], status: DnaJobStatusResponseDto['status']): number {
  if (typeof progress === 'number') return progress;
  if (status === 'completed') return 100;
  if (status === 'processing') return 40;
  return 10;
}

export async function getDnaJobStatus(dnaQueue: Queue, jobId: string): Promise<DnaJobStatusResponseDto> {
  const job = await dnaQueue.getJob(jobId);
  if (!job) {
    throw new NotFoundException(`Job ${jobId} not found`);
  }

  const state = (await job.getState()) as BullMQJobState;
  const status = mapBullStateToDnaStatus(state);

  return {
    jobId: job.id!,
    status,
    progress: toProgress(job.progress, status),
    result: status === 'completed' ? job.returnvalue : undefined,
    error: status === 'failed' ? job.failedReason : undefined,
  };
}

export function streamDnaJobStatus(dnaQueue: Queue, jobId: string): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastPayload = '';

    const emit = async () => {
      try {
        const status = await getDnaJobStatus(dnaQueue, jobId);
        const payload = JSON.stringify(status);

        if (payload !== lastPayload) {
          subscriber.next({ type: 'status', data: payload } as MessageEvent);
          subscriber.next({ type: 'progress', data: JSON.stringify({ jobId: status.jobId, progress: status.progress }) } as MessageEvent);
          lastPayload = payload;
        }

        if (status.status === 'completed') {
          subscriber.next({ type: 'result', data: JSON.stringify(status.result ?? null) } as MessageEvent);
          subscriber.complete();
        }

        if (status.status === 'failed') {
          subscriber.next({ type: 'error', data: JSON.stringify({ jobId: status.jobId, error: status.error ?? 'Generation failed' }) } as MessageEvent);
          subscriber.complete();
        }
      } catch (error) {
        subscriber.error(error);
      }
    };

    void emit();
    timer = setInterval(() => void emit(), 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  });
}
