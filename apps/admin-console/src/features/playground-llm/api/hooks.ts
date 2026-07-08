'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { cancelTask, generateAssembled, generateText, getTask, listGuardrailProviders, listProviders } from './client';
import { analyzeGuardrail, extractEntities } from './inference-client';
import { playgroundLlmKeys } from './keys';
import type { AssembledGenerateRequest, GenerateTextRequest, GuardrailType } from './types';

export function useSmrProviders(tenantKey?: string) {
    return useQuery({ queryKey: playgroundLlmKeys.providers(tenantKey), queryFn: () => listProviders(tenantKey) });
}

export function useSmrGuardrailProviders(tenantKey?: string) {
    return useQuery({ queryKey: playgroundLlmKeys.guardrailProviders(tenantKey), queryFn: () => listGuardrailProviders(tenantKey) });
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Post-mortem read for the frame 54 error variant: "task FAILED → GET
 * /text/tasks/:taskId". Acts as the stream finalizer: while the dropped task
 * is still non-terminal upstream it keeps polling so the pane can recover the
 * full content once the task completes server-side.
 */
export function useSmrTask(taskId: string | null, enabled: boolean) {
    return useQuery({
        queryKey: playgroundLlmKeys.task(taskId ?? 'none'),
        queryFn: () => getTask(taskId as string),
        enabled: enabled && !!taskId,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            if (!status || TERMINAL_TASK_STATUSES.has(status)) return false;
            return 2000;
        },
    });
}

export function useGenerateText() {
    return useMutation({ mutationFn: (body: GenerateTextRequest) => generateText(body) });
}

export function useGenerateAssembled() {
    return useMutation({ mutationFn: (body: AssembledGenerateRequest) => generateAssembled(body) });
}

export function useCancelTask() {
    return useMutation({ mutationFn: (taskId: string) => cancelTask(taskId) });
}

/** TASK-446 — Guardrails tab: content-safety / PII / prompt-injection analysis. */
export function useAnalyzeGuardrail() {
    return useMutation({ mutationFn: (body: { text: string; guardrailType?: GuardrailType }) => analyzeGuardrail(body) });
}

/** TASK-446 — NER tab: medical entity extraction (token classification). */
export function useExtractEntities() {
    return useMutation({ mutationFn: (body: { text: string; aggregationStrategy?: string; language?: string }) => extractEntities(body) });
}
