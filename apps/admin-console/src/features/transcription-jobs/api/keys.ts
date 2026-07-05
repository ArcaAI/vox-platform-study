import type { TranscriptionJobStatus } from './types';

export const transcriptionJobKeys = {
    root: ['transcription-jobs'] as const,
    list: (params?: { page?: number; limit?: number }) => [...transcriptionJobKeys.root, 'list', params ?? {}] as const,
    stats: () => [...transcriptionJobKeys.root, 'stats'] as const,
    byStatus: (status: TranscriptionJobStatus) => [...transcriptionJobKeys.root, 'status', status] as const,
    detail: (id: string) => [...transcriptionJobKeys.root, 'detail', id] as const,
};
