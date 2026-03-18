import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { smrClient } from './smr-client';
import type {
  SmrGenerateRequest,
  SmrGenerateResponse,
  SmrStreamingResponse,
  SmrTaskResponse,
  SmrProvider,
  SmrHealthResponse,
} from './types';

const keys = {
  all: ['summarization'] as const,
  providers: () => [...keys.all, 'providers'] as const,
  health: () => [...keys.all, 'health'] as const,
  task: (id: string) => [...keys.all, 'task', id] as const,
  history: () => [...keys.all, 'history'] as const,
};

export function useSmrProviders() {
  return useQuery({
    queryKey: keys.providers(),
    queryFn: () => smrClient.get<SmrProvider[]>('/text/providers'),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useSmrHealth() {
  return useQuery({
    queryKey: keys.health(),
    queryFn: () => smrClient.get<SmrHealthResponse>('/health/services/smr'),
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useSmrTaskStatus(taskId: string | null) {
  return useQuery({
    queryKey: keys.task(taskId ?? ''),
    queryFn: () => smrClient.get<SmrTaskResponse>(`/text/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return false;
      return 2000;
    },
  });
}

export function useGenerateSync() {
  return useMutation({
    mutationFn: (req: SmrGenerateRequest) =>
      smrClient.post<SmrGenerateResponse>('/text/generate', { ...req, stream: false }, {
        timeout: 120_000,
      }),
  });
}

export function useGenerateAsync() {
  return useMutation({
    mutationFn: (req: SmrGenerateRequest) =>
      smrClient.post<SmrStreamingResponse>('/text/generate', { ...req, stream: true }),
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      smrClient.post<void>(`/text/tasks/${taskId}/cancel`),
    onSuccess: (_, taskId) => {
      queryClient.invalidateQueries({ queryKey: keys.task(taskId) });
    },
  });
}

export function useGeneratePreSummary() {
  return useMutation({
    mutationFn: ({
      contextText,
      templateContent,
      provider,
      model,
      temperature,
      maxTokens,
    }: {
      contextText: string;
      templateContent?: string;
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      const systemPrompt = templateContent ??
        `You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans. Output should be structured and easy to review.`;

      const prompt = `Generate a pre-summary from the following clinical context:\n\n${contextText}`;

      return smrClient.post<SmrGenerateResponse>(
        '/text/generate',
        {
          prompt,
          system_prompt: systemPrompt,
          provider: provider || 'ollama',
          model: model || undefined,
          temperature: temperature ?? 0.3,
          max_tokens: maxTokens ?? 2048,
          stream: false,
        } satisfies SmrGenerateRequest,
        { timeout: 120_000 },
      );
    },
  });
}

export function useGenerateSummary() {
  return useMutation({
    mutationFn: ({
      transcript,
      preSummaryText,
      additionalContext,
      templateContent,
      dnaStyleText,
      format,
      includeNER,
      provider,
      model,
      temperature,
      maxTokens,
    }: {
      transcript: string;
      preSummaryText?: string;
      additionalContext?: string;
      templateContent?: string;
      dnaStyleText?: string;
      format?: 'SOAP' | 'narrative';
      includeNER?: boolean;
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      let systemPrompt = templateContent ??
        `You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.`;

      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      if (format === 'SOAP') {
        systemPrompt += `\n\nFormat the summary using SOAP format (Subjective, Objective, Assessment, Plan).`;
      }

      if (includeNER) {
        systemPrompt += `\n\nAlso extract named medical entities (medications, conditions, procedures) and list them at the end.`;
      }

      let prompt = `Generate a clinical summary from the following transcript:\n\n${transcript}`;

      if (preSummaryText) {
        prompt += `\n\n--- Pre-Summary Context ---\n${preSummaryText}`;
      }

      if (additionalContext) {
        prompt += `\n\n--- Additional Context ---\n${additionalContext}`;
      }

      return smrClient.post<SmrGenerateResponse>(
        '/text/generate',
        {
          prompt,
          system_prompt: systemPrompt,
          provider: provider || 'ollama',
          model: model || undefined,
          temperature: temperature ?? 0.4,
          max_tokens: maxTokens ?? 4096,
          stream: false,
        } satisfies SmrGenerateRequest,
        { timeout: 120_000 },
      );
    },
  });
}

export function useStreamPreSummary() {
  return useMutation({
    mutationFn: async ({
      contextText,
      templateContent,
      provider,
      model,
      temperature,
      maxTokens,
      onChunk,
      onDone,
      signal,
    }: {
      contextText: string;
      templateContent?: string;
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      onChunk: (text: string) => void;
      onDone?: (taskId: string) => void;
      signal?: AbortSignal;
    }) => {
      const systemPrompt = templateContent ??
        `You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans. Output should be structured and easy to review.`;

      const prompt = `Generate a pre-summary from the following clinical context:\n\n${contextText}`;

      const taskRes = await smrClient.post<SmrStreamingResponse>(
        '/text/generate',
        {
          prompt,
          system_prompt: systemPrompt,
          provider: provider || 'ollama',
          model: model || undefined,
          temperature: temperature ?? 0.3,
          max_tokens: maxTokens ?? 2048,
          stream: true,
        } satisfies SmrGenerateRequest,
      );

      await smrClient.sse(
        `/text/tasks/${taskRes.task_id}/stream`,
        (data: string) => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.content || parsed.text || parsed.delta?.content || '';
            if (text) onChunk(text);
          } catch { /* skip non-JSON */ }
        },
        () => onDone?.(taskRes.task_id),
      );

      return taskRes;
    },
  });
}

export function useStreamSummary() {
  return useMutation({
    mutationFn: async ({
      transcript,
      preSummaryText,
      additionalContext,
      templateContent,
      dnaStyleText,
      format,
      includeNER,
      provider,
      model,
      temperature,
      maxTokens,
      onChunk,
      onDone,
      signal,
    }: {
      transcript: string;
      preSummaryText?: string;
      additionalContext?: string;
      templateContent?: string;
      dnaStyleText?: string;
      format?: 'SOAP' | 'narrative';
      includeNER?: boolean;
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      onChunk: (text: string) => void;
      onDone?: (taskId: string) => void;
      signal?: AbortSignal;
    }) => {
      let systemPrompt = templateContent ??
        `You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.`;

      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      if (format === 'SOAP') {
        systemPrompt += `\n\nFormat the summary using SOAP format (Subjective, Objective, Assessment, Plan).`;
      }

      if (includeNER) {
        systemPrompt += `\n\nAlso extract named medical entities (medications, conditions, procedures) and list them at the end.`;
      }

      let prompt = `Generate a clinical summary from the following transcript:\n\n${transcript}`;

      if (preSummaryText) {
        prompt += `\n\n--- Pre-Summary Context ---\n${preSummaryText}`;
      }

      if (additionalContext) {
        prompt += `\n\n--- Additional Context ---\n${additionalContext}`;
      }

      const taskRes = await smrClient.post<SmrStreamingResponse>(
        '/text/generate',
        {
          prompt,
          system_prompt: systemPrompt,
          provider: provider || 'ollama',
          model: model || undefined,
          temperature: temperature ?? 0.4,
          max_tokens: maxTokens ?? 4096,
          stream: true,
        } satisfies SmrGenerateRequest,
      );

      await smrClient.sse(
        `/text/tasks/${taskRes.task_id}/stream`,
        (data: string) => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.content || parsed.text || parsed.delta?.content || '';
            if (text) onChunk(text);
          } catch { /* skip non-JSON */ }
        },
        () => onDone?.(taskRes.task_id),
      );

      return taskRes;
    },
  });
}

export { keys as summarizationKeys };
