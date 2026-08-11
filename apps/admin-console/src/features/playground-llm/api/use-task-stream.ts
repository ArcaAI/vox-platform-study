'use client';

/**
 * The SMR task SSE consumer moved to `@/shared/streams` (BUG-018) so the
 * prompt-template Test tab can stream the same job kind without a
 * cross-feature import. Re-exported here to keep this feature's import paths
 * stable.
 */

export { useTaskStream } from '@/shared/streams/use-task-stream';
export type { TaskStreamState, TaskStreamStatus } from '@/shared/streams/use-task-stream';
