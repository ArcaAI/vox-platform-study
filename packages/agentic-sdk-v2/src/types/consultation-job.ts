/**
 * @arcaai/vox - Consultation Job Types (TASK-032 WS-A)
 *
 * Types for consultation job tracking (SSE + polling).
 */

export type JobStatus = 'idle' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ConsultationJob {
  id: string;
  status: string;
  progress?: number;
  consultationId: string;
  currentStep?: string;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  [key: string]: unknown;
}

export interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

export interface JobStreamCallbacks {
  onStatus?: (status: string) => void;
  onProgress?: (progress: number) => void;
  onResult?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * TASK-299 D-8 — case-insensitive terminal-status check. The backend has
 * historically emitted both `COMPLETED` and `completed`; either should
 * resolve to a terminal state.
 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_STATUSES.has(status.toLowerCase());
}
