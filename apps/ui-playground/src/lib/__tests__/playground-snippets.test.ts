/**
 * TASK-329 — playground snippet builders.
 *
 * The builders are the reactive core of LiveCodePanel: pure functions whose output
 * must faithfully reflect the current store / impersonated-user preferences. These
 * tests pin that contract (inputs surface in the snippet) + determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAudioSnippet,
  buildConsultationSnippet,
  buildDnaSnippet,
  buildOverviewSnippet,
  buildSummarizationSnippet,
  buildVoiceSnippet,
} from '../playground-snippets';

describe('playground-snippets', () => {
  describe('shared context header', () => {
    it('surfaces the tenant id and impersonated user', () => {
      const code = buildOverviewSnippet({ tenantId: 'tenant-123', userLabel: 'dr.who' });
      expect(code).toContain('// tenant: tenant-123, acting as @dr.who');
    });

    it('falls back to placeholders when tenant / user are absent', () => {
      const code = buildOverviewSnippet({});
      expect(code).toContain('// tenant: <select-a-tenant>');
      // The header omits the "acting as @<user>" suffix (the snippet body's own
      // `acting as ${impersonatedUser?.username}` is unrelated to the header).
      expect(code).not.toContain('acting as @');
    });

    it('is deterministic for identical inputs', () => {
      const ctx = { tenantId: 't1', userLabel: 'u1' };
      expect(buildOverviewSnippet(ctx)).toBe(buildOverviewSnippet(ctx));
    });
  });

  describe('overview', () => {
    it('uses the vox auth/config hooks and only mentions super-admin tenant switching when applicable', () => {
      const base = buildOverviewSnippet({ tenantId: 't1' });
      expect(base).toContain("from '@arcaai/vox'");
      expect(base).toContain('useAuth');
      expect(base).toContain('useArcaConfig');
      expect(base).not.toContain('super-admin');

      expect(buildOverviewSnippet({ tenantId: 't1', isSuperAdmin: true })).toContain('super-admin');
    });
  });

  describe('consultation', () => {
    it('binds the P2 chain + recordings hooks to the selected consultation', () => {
      const code = buildConsultationSnippet({ tenantId: 't1', consultationId: 'consult-9' });
      expect(code).toContain('useConsultationChain');
      expect(code).toContain('useAudioRecordings');
      expect(code).toContain("fetchChain('consult-9')");
      expect(code).toContain("list('consult-9')");
    });

    it('emits undefined (not a bogus id) when no consultation is open', () => {
      const code = buildConsultationSnippet({});
      expect(code).toContain('// consultation: <open-a-consultation>');
      expect(code).toContain('fetchChain(undefined)');
    });
  });

  describe('audio', () => {
    it('uses the REAL @arcaai/vox useArcaAudio hook (not the playground useRealtimeTranscription)', () => {
      const code = buildAudioSnippet({ modelId: 'whisper-large-v3', task: 'translate', language: 'vi' });
      // F8 — the real SDK audio hook is useArcaAudio; useRealtimeTranscription
      // is a playground-only hook with a different option shape.
      expect(code).toContain("import { useArcaAudio } from '@arcaai/vox'");
      expect(code).not.toContain('useRealtimeTranscription');
      expect(code).toContain('useArcaAudio()');
      expect(code).toContain('startFromPreferences');
      expect(code).toContain('isCapturing');
      expect(code).toContain('currentTranscript');
      // model / task / language reflect the current selection — surfaced in a
      // comment because they come from resolved config, not start() args.
      expect(code).toContain('whisper-large-v3');
      expect(code).toContain('translate');
      expect(code).toContain('vi');
    });

    it('defaults model/task/language when unset', () => {
      const code = buildAudioSnippet({});
      expect(code).toContain('whisper-base');
      expect(code).toContain('transcribe');
      expect(code).toContain('auto');
    });
  });

  describe('voice', () => {
    it('resolves the chosen provider and explains where embeddings are computed', () => {
      const local = buildVoiceSnippet({ provider: 'local' });
      expect(local).toContain('resolveVoiceEnrollmentProvider');
      expect(local).toContain("preferred: 'local'");
      expect(local).toContain('in-browser');

      const backend = buildVoiceSnippet({ provider: 'backend' });
      expect(backend).toContain("preferred: 'backend'");
      expect(backend).toContain('backend voice service');
    });
  });

  describe('dna', () => {
    it('uses the REAL @arcaai/vox useDnaStyle hook (not the app-internal api path)', () => {
      const code = buildDnaSnippet({ reportId: 'r1', version: 4, tone: 'concise' });
      // F8 — @arcaai/vox exports useDnaStyle; the snippet must not reference the
      // app-internal `@/features/...` path (not a real SDK export).
      expect(code).toContain("import { useDnaStyle } from '@arcaai/vox'");
      expect(code).not.toContain('@/features/dna-writing-style');
      expect(code).toContain('useDnaStyle()');
      expect(code).toContain('generate');
      expect(code).toContain('// current style: v4 · concise');
    });

    it('shows an empty hint when the user has no style yet', () => {
      const code = buildDnaSnippet({ reportId: null, version: null });
      expect(code).toContain('none yet');
    });
  });

  describe('summarization', () => {
    it('emits the assembled-route contract: snake_case ids + context_item_ids', () => {
      const code = buildSummarizationSnippet({
        provider: 'openai',
        model: 'gpt-4o',
        promptTemplateId: 'tpl-1',
        dnaStyleId: 'dna-1',
        contextItemIds: ['ctx-1', 'ctx-2'],
        temperature: 0.7,
        maxTokens: 2048,
        includeNER: true,
        streaming: true,
      });
      expect(code).toContain("provider: 'openai'");
      expect(code).toContain("model: 'gpt-4o'");
      // F8 — the assembled route is ID-based + snake_case (matches pre-summary's
      // POST /text/generate/assembled body), not camelCase raw-text fields.
      expect(code).toContain("prompt_template_id: 'tpl-1'");
      expect(code).toContain("dna_writing_style_id: 'dna-1'");
      expect(code).toContain('context_item_ids:');
      expect(code).toContain("'ctx-1'");
      expect(code).toContain("'ctx-2'");
      expect(code).not.toContain('promptTemplateId');
      expect(code).not.toContain('dnaStyleId');
      expect(code).toContain('temperature: 0.7');
      expect(code).toContain('stream: true');
    });

    it('uses undefined for unset optional ids, empty context_item_ids, and defaults otherwise', () => {
      const code = buildSummarizationSnippet({ provider: 'ollama' });
      expect(code).toContain('prompt_template_id: undefined');
      expect(code).toContain('dna_writing_style_id: undefined');
      expect(code).toContain('context_item_ids: []');
      expect(code).toContain('temperature: 0.4');
      expect(code).toContain('maxTokens: 4096');
      expect(code).toContain('includeNER: false');
    });
  });
});
