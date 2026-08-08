'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { cancelTask, generateAssembled, generateText, getTask, listGuardrailProviders, listPromptTemplates, listProviders } from './client';
import { analyzeGuardrail, extractEntities } from './inference-client';
import { playgroundLlmKeys } from './keys';
import type { AssembledGenerateRequest, GenerateTextRequest, GuardrailType, ListPromptTemplatesParams } from './types';

export function useSmrProviders(tenantKey?: string) {
  return useQuery({ queryKey: playgroundLlmKeys.providers(tenantKey), queryFn: () => listProviders(tenantKey) });
}

/**
 * Template picker (assembled mode). `retry: false` so a load failure
 * surfaces quickly — the picker falls back to a plain text input rather than
 * blocking the playground on a flaky read.
 */
export function usePromptTemplates(params?: ListPromptTemplatesParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: playgroundLlmKeys.templates(params),
    queryFn: () => listPromptTemplates(params),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    retry: false,
  });
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

/** Guardrails tab: content-safety / PII / prompt-injection analysis. */
export function useAnalyzeGuardrail() {
  return useMutation({ mutationFn: (body: { text: string; guardrailType?: GuardrailType }) => analyzeGuardrail(body) });
}

/** NER tab: medical entity extraction (token classification). */
export function useExtractEntities() {
  return useMutation({ mutationFn: (body: { text: string; aggregationStrategy?: string; language?: string }) => extractEntities(body) });
}
