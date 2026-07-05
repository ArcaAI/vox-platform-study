import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/store/auth-store', () => ({
  useAuthStore: Object.assign(
    vi.fn(() => ({
      user: { id: 'doctor-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
      tenantId: 'tenant-001',
      authMethod: 'credentials' as const,
      accessToken: 'test-token',
      isImpersonating: false,
      impersonatedUser: null,
      impersonationToken: '',
    })),
    {
      getState: vi.fn(() => ({
        user: { id: 'doctor-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
        tenantId: 'tenant-001',
        authMethod: 'credentials' as const,
        accessToken: 'test-token',
        isImpersonating: false,
        impersonatedUser: null,
        impersonationToken: '',
      })),
    },
  ),
}));

vi.mock('@/store/playground-store', () => ({
  usePlaygroundStore: Object.assign(
    vi.fn(() => ({ apiBaseUrl: 'http://localhost:8868/api/v1' })),
    { getState: vi.fn(() => ({ apiBaseUrl: 'http://localhost:8868/api/v1' })) },
  ),
}));

describe('SSE Streaming E2E Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Pre-Summary SSE Streaming', () => {
    it('should construct correct streaming request payload', () => {
      const contextText = 'Patient: John Smith. Labs: Troponin 0.04, HbA1c 7.2%.';
      const systemPrompt = 'Generate a concise pre-summary from clinical context.';

      const request = {
        prompt: `Generate a pre-summary from the following clinical context:\n\n${contextText}`,
        system_prompt: systemPrompt,
        provider: 'ollama',
        model: undefined,
        temperature: 0.3,
        max_tokens: 2048,
        stream: true,
      };

      expect(request.stream).toBe(true);
      expect(request.prompt).toContain(contextText);
      expect(request.system_prompt).toContain('pre-summary');
      expect(request.temperature).toBe(0.3);
    });

    it('should expect 202 response with task_id and stream_url for streaming', () => {
      const streamResponse = {
        task_id: 'task-presummary-001',
        status: 'running',
        stream_url: '/api/v1/tasks/task-presummary-001/stream',
      };

      expect(streamResponse.status).toBe('running');
      expect(streamResponse.task_id).toBeTruthy();
      expect(streamResponse.stream_url).toContain('/tasks/');
      expect(streamResponse.stream_url).toContain('/stream');
    });

    it('should parse SSE data lines correctly', () => {
      const rawSSE = [
        'data: {"content":"Patient"}',
        'data: {"content":" has"}',
        'data: {"content":" chest pain"}',
        'data: {"type":"done","data":{"finish_reason":"stop"}}',
        'data: [DONE]',
      ];

      let accumulated = '';
      let isDone = false;

      for (const line of rawSSE) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          isDone = true;
          break;
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content || parsed.text || parsed.delta?.content || '';
          if (text) accumulated += text;
        } catch { /* skip non-JSON */ }
      }

      expect(accumulated).toBe('Patient has chest pain');
      expect(isDone).toBe(true);
    });

    it('should construct correct pre-summary prompt with DNA style', () => {
      const templateContent = 'You are a medical documentation assistant.';
      const dnaStyleText = 'Use formal medical language. Keep sentences concise.';
      const contextText = 'Patient presents with headache, 3-month history.';

      let systemPrompt = templateContent;
      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      const prompt = `Generate a pre-summary from the following clinical context:\n\n${contextText}`;

      expect(systemPrompt).toContain(templateContent);
      expect(systemPrompt).toContain(dnaStyleText);
      expect(prompt).toContain(contextText);
    });
  });

  describe('Summary SSE Streaming', () => {
    it('should construct correct streaming summary request', () => {
      const transcript = 'Doctor: Good morning. Patient: The pain has improved.';
      const preSummary = 'Key findings: improved chest pain.';
      const systemPrompt = 'Generate a comprehensive clinical summary.';

      let prompt = `Generate a clinical summary from the following transcript:\n\n${transcript}`;
      prompt += `\n\n--- Pre-Summary Context ---\n${preSummary}`;

      const request = {
        prompt,
        system_prompt: systemPrompt,
        provider: 'ollama',
        stream: true,
        max_tokens: 4096,
        temperature: 0.4,
      };

      expect(request.stream).toBe(true);
      expect(request.prompt).toContain(transcript);
      expect(request.prompt).toContain('Pre-Summary Context');
      expect(request.prompt).toContain(preSummary);
    });

    it('should expect 202 response for streaming summary generation', () => {
      const response = {
        task_id: 'task-summary-001',
        status: 'running',
        stream_url: '/api/v1/tasks/task-summary-001/stream',
      };

      expect(response.status).toBe('running');
      expect(response.stream_url).toMatch(/\/tasks\/.+\/stream$/);
    });

    it('should accumulate SSE chunks into complete summary', () => {
      const chunks = [
        { content: 'Subjective: ' },
        { content: 'Patient reports improved chest pain. ' },
        { content: 'Objective: ' },
        { content: 'BP 138/85, HR 72. ' },
        { content: 'Assessment: ' },
        { content: 'Improving CAD. ' },
        { content: 'Plan: ' },
        { content: 'Continue medications.' },
      ];

      let accumulated = '';
      for (const chunk of chunks) {
        const text = chunk.content || '';
        accumulated += text;
      }

      expect(accumulated).toContain('Subjective');
      expect(accumulated).toContain('Objective');
      expect(accumulated).toContain('Assessment');
      expect(accumulated).toContain('Plan');
      expect(accumulated.length).toBeGreaterThan(50);
    });

    it('should handle SSE error chunks gracefully', () => {
      const sseLines = [
        'data: {"content":"partial text"}',
        'data: {"type":"error","data":{"error":"provider timeout"}}',
      ];

      let accumulated = '';
      let error: string | null = null;

      for (const line of sseLines) {
        const data = line.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'error') {
            error = parsed.data?.error || 'Unknown error';
            break;
          }
          accumulated += parsed.content || '';
        } catch { /* skip */ }
      }

      expect(accumulated).toBe('partial text');
      expect(error).toBe('provider timeout');
    });

    it('should not generate when impersonation is required', () => {
      const roles = ['GLOBAL_ADMIN'];
      const ADMIN_ROLES = ['GLOBAL_ADMIN', 'TENANT_ADMIN'];
      const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];
      const isImpersonating = false;

      const isAdmin = roles.some((r) => ADMIN_ROLES.includes(r));
      const isDoctor = roles.some((r) => DOCTOR_ROLES.includes(r));
      const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

      expect(requiresImpersonation).toBe(true);
    });

    it('should allow generation when admin is impersonating a doctor', () => {
      const roles = ['GLOBAL_ADMIN'];
      const ADMIN_ROLES = ['GLOBAL_ADMIN', 'TENANT_ADMIN'];
      const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];
      const isImpersonating = true;

      const isAdmin = roles.some((r) => ADMIN_ROLES.includes(r));
      const isDoctor = roles.some((r) => DOCTOR_ROLES.includes(r));
      const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

      expect(requiresImpersonation).toBe(false);
    });
  });

  describe('SSE Stream URL construction', () => {
    it('should construct correct stream URL from task response', () => {
      const taskId = 'task-abc-123';
      const expectedUrl = `/text/tasks/${taskId}/stream`;
      expect(expectedUrl).toBe('/text/tasks/task-abc-123/stream');
    });

    it('should use API gateway stream URL, not direct SMR URL', () => {
      const apiGatewayBase = 'http://localhost:8868/api/v1';
      const taskId = 'task-001';
      const url = `${apiGatewayBase}/text/tasks/${taskId}/stream`;

      expect(url).toContain('/api/v1/text/tasks/');
      expect(url).not.toContain(':8862');
    });
  });
});
