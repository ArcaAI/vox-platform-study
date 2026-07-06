'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    bulkJobAction,
    cleanQueue,
    getJob,
    getQueue,
    listJobs,
    listQueues,
    listSchedulers,
    pauseQueue,
    pauseScheduler,
    promoteJob,
    removeJob,
    resumeQueue,
    resumeScheduler,
    retryJob,
    toggleScheduler,
    updateSchedulerCron,
} from './client';
import { queueKeys } from './keys';
import type { BulkJobActionRequest, CleanQueueRequest, ListJobsParams } from './types';

/** Queue boards poll fast — job counts move constantly. */
const REFRESH_MS = 15_000;

export function useQueues() {
    return useQuery({ queryKey: queueKeys.list(), queryFn: listQueues, refetchInterval: REFRESH_MS });
}

export function useQueue(queueName: string) {
    return useQuery({ queryKey: queueKeys.detail(queueName), queryFn: () => getQueue(queueName), enabled: !!queueName, refetchInterval: REFRESH_MS });
}

export function useJobs(queueName: string, params?: ListJobsParams) {
    return useQuery({
        queryKey: queueKeys.jobs(queueName, params),
        queryFn: () => listJobs(queueName, params),
        enabled: !!queueName,
        placeholderData: keepPreviousData,
    });
}

export function useJob(queueName: string, jobId: string) {
    return useQuery({ queryKey: queueKeys.job(queueName, jobId), queryFn: () => getJob(queueName, jobId), enabled: !!queueName && !!jobId });
}

export function useSchedulers() {
    return useQuery({ queryKey: queueKeys.schedulers(), queryFn: listSchedulers });
}

function useInvalidateQueues() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: queueKeys.root });
}

export function usePauseQueue() {
    const invalidate = useInvalidateQueues();
    return useMutation({ mutationFn: (queueName: string) => pauseQueue(queueName), onSuccess: invalidate });
}

export function useResumeQueue() {
    const invalidate = useInvalidateQueues();
    return useMutation({ mutationFn: (queueName: string) => resumeQueue(queueName), onSuccess: invalidate });
}

export function useCleanQueue() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ queueName, body }: { queueName: string; body: CleanQueueRequest }) => cleanQueue(queueName, body),
        onSuccess: invalidate,
    });
}

export function useRetryJob() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ queueName, jobId }: { queueName: string; jobId: string }) => retryJob(queueName, jobId),
        onSuccess: invalidate,
    });
}

export function usePromoteJob() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ queueName, jobId }: { queueName: string; jobId: string }) => promoteJob(queueName, jobId),
        onSuccess: invalidate,
    });
}

export function useRemoveJob() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ queueName, jobId }: { queueName: string; jobId: string }) => removeJob(queueName, jobId),
        onSuccess: invalidate,
    });
}

export function useBulkJobAction() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ queueName, body }: { queueName: string; body: BulkJobActionRequest }) => bulkJobAction(queueName, body),
        onSuccess: invalidate,
    });
}

export function usePauseScheduler() {
    const invalidate = useInvalidateQueues();
    return useMutation({ mutationFn: (name: string) => pauseScheduler(name), onSuccess: invalidate });
}

export function useResumeScheduler() {
    const invalidate = useInvalidateQueues();
    return useMutation({ mutationFn: (name: string) => resumeScheduler(name), onSuccess: invalidate });
}

export function useUpdateSchedulerCron() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ name, cronExpression }: { name: string; cronExpression: string }) => updateSchedulerCron(name, cronExpression),
        onSuccess: invalidate,
    });
}

export function useToggleScheduler() {
    const invalidate = useInvalidateQueues();
    return useMutation({
        mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => toggleScheduler(name, enabled),
        onSuccess: invalidate,
    });
}
