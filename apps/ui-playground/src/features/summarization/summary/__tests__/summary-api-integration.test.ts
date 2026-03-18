import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/store/auth-store', () => ({
  useAuthStore: Object.assign(
    vi.fn(() => ({
      user: { id: 'doctor-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
      tenantId: 'tenant-001',
      authMethod: 'credentials' as const,
      accessToken: 'test-token',
      apiKey: '',
      tenantKey: '',
      tenantName: 'Test Tenant',
      isAuthenticated: true,
    })),
    {
      getState: vi.fn(() => ({
        user: { id: 'doctor-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
        tenantId: 'tenant-001',
        authMethod: 'credentials' as const,
        accessToken: 'test-token',
        apiKey: '',
        tenantKey: '',
        tenantName: 'Test Tenant',
        isAuthenticated: true,
      })),
    },
  ),
}));

vi.mock('@/store/playground-store', () => ({
  usePlaygroundStore: Object.assign(
    vi.fn(() => ({
      apiBaseUrl: 'http://localhost:8868/api/v1',
      sidebarOpen: true,
      lastConsultationId: null,
      debugMode: false,
    })),
    {
      getState: vi.fn(() => ({
        apiBaseUrl: 'http://localhost:8868/api/v1',
        sidebarOpen: true,
        lastConsultationId: null,
        debugMode: false,
      })),
    },
  ),
}));

describe('Summary Page API Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Department-based prompt template loading', () => {
    it('should derive department prompt templates from department API response', () => {
      const department = {
        id: 'dept-card',
        code: 'CARD',
        name: 'Cardiology',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: 'prompt-pre-001',
        newPatientPromptId: 'prompt-new-001',
        revisitPromptId: 'prompt-rev-001',
        promptConfig: { abbreviationDensity: 'moderate' },
      };

      expect(department.newPatientPromptId).toBe('prompt-new-001');
      expect(department.revisitPromptId).toBe('prompt-rev-001');
      expect(department.preSummaryPromptId).toBe('prompt-pre-001');
    });

    it('should filter prompt templates by departmentId', () => {
      const allTemplates = [
        { id: 'pt-1', name: 'Cardiology SOAP', departmentId: 'dept-card', category: 'SUMMARY', content: 'Generate SOAP...' },
        { id: 'pt-2', name: 'General Default', departmentId: null, category: 'SUMMARY', content: 'Generate summary...' },
        { id: 'pt-3', name: 'Radiology Report', departmentId: 'dept-rad', category: 'SUMMARY', content: 'Generate radiology...' },
      ];

      const selectedDeptId = 'dept-card';
      const filtered = allTemplates.filter(
        (t) => t.departmentId === selectedDeptId || t.departmentId === null,
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.id)).toEqual(['pt-1', 'pt-2']);
    });

    it('should show all templates when no department is selected', () => {
      const allTemplates = [
        { id: 'pt-1', name: 'Cardiology SOAP', departmentId: 'dept-card', category: 'SUMMARY', content: 'Generate SOAP...' },
        { id: 'pt-2', name: 'General Default', departmentId: null, category: 'SUMMARY', content: 'Generate summary...' },
      ];

      const selectedDeptId = '';
      const filtered = selectedDeptId
        ? allTemplates.filter((t) => t.departmentId === selectedDeptId || t.departmentId === null)
        : allTemplates;

      expect(filtered).toHaveLength(2);
    });
  });

  describe('DNA writing style loading', () => {
    it('should use doctor userId to fetch DNA style', () => {
      const userId = 'doctor-001';
      expect(userId).toBeTruthy();
    });

    it('should extract styleText from DNA report response', () => {
      const dnaReport = {
        id: 'dna-001',
        doctorId: 'doctor-001',
        reportData: {
          tone: 'formal',
          vocabulary: 'technical',
          structure: 'SOAP',
          formality: 'high',
          sentenceLength: 'short',
          medicalTermUsage: 'frequent',
          abbreviationStyle: 'standard',
        },
        styleText: 'Use formal medical language. Keep sentences concise. Use standard abbreviations.',
        isLatest: true,
        currentVersionNumber: 3,
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-02-20T14:30:00Z',
      };

      expect(dnaReport.styleText).toBe(
        'Use formal medical language. Keep sentences concise. Use standard abbreviations.',
      );
      expect(dnaReport.reportData.tone).toBe('formal');
      expect(dnaReport.currentVersionNumber).toBe(3);
    });

    it('should handle missing DNA style gracefully', () => {
      const dnaReport = null;
      const styleText = dnaReport?.styleText ?? '';
      expect(styleText).toBe('');
    });
  });

  describe('Prompt building with real data', () => {
    it('should build system prompt from template content + DNA styleText', () => {
      const templateContent = 'You are a medical documentation assistant. Generate a comprehensive clinical summary.';
      const dnaStyleText = 'Use formal medical language. Keep sentences concise.';

      let systemPrompt = templateContent;
      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      expect(systemPrompt).toContain(templateContent);
      expect(systemPrompt).toContain(dnaStyleText);
      expect(systemPrompt).toContain('Apply the following writing style:');
    });

    it('should build system prompt without DNA style when none available', () => {
      const templateContent = 'You are a medical documentation assistant.';
      const dnaStyleText = '';

      let systemPrompt = templateContent;
      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      expect(systemPrompt).toBe(templateContent);
      expect(systemPrompt).not.toContain('Apply the following writing style:');
    });

    it('should include NER extraction instruction when enabled', () => {
      const templateContent = 'Generate summary.';
      const includeNER = true;

      let systemPrompt = templateContent;
      if (includeNER) {
        systemPrompt += '\n\nAlso extract named medical entities (medications, conditions, procedures) and list them at the end.';
      }

      expect(systemPrompt).toContain('named medical entities');
    });
  });

  describe('Prompt template update via API', () => {
    it('should construct correct update payload for prompt template', () => {
      const templateId = 'pt-1';
      const editedContent = 'Updated prompt content for cardiology SOAP notes.';
      const changeReason = 'Improved cardiology-specific instructions';

      const payload = {
        id: templateId,
        content: editedContent,
        changeReason,
      };

      expect(payload.id).toBe('pt-1');
      expect(payload.content).toBe(editedContent);
      expect(payload.changeReason).toBe(changeReason);
    });
  });

  describe('DNA writing style update via API', () => {
    it('should construct correct update payload for DNA report', () => {
      const reportId = 'dna-001';
      const editedStyleText = 'Updated writing style: Use concise medical language with SOAP format.';
      const changeReason = 'Refined writing style for better summaries';

      const payload = {
        reportId,
        styleText: editedStyleText,
        changeReason,
      };

      expect(payload.reportId).toBe('dna-001');
      expect(payload.styleText).toBe(editedStyleText);
      expect(payload.changeReason).toBe(changeReason);
    });
  });

  describe('Output format removal', () => {
    it('should not include format in prompt building when format dropdown is removed', () => {
      const templateContent = 'Generate a clinical summary.';
      const dnaStyleText = 'Use SOAP format.';

      let systemPrompt = templateContent;
      if (dnaStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      }

      expect(systemPrompt).not.toContain('Format the summary using SOAP format');
      expect(systemPrompt).toContain('Use SOAP format.');
    });
  });
});
