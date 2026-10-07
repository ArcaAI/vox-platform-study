/**
 * TASK-1050 W2e — the guardrail services load through the package barrel without an import cycle
 * leaving a DI token or a class undefined at decoration time (the consultation barrel re-exports them).
 */
import { describe, expect, it } from 'vitest';

describe('@arcaai/applications barrel — TASK-1050 guardrail exports', () => {
  it('exposes the services, modules, tokens and DTOs', async () => {
    const barrel = (await import('../../../index')) as Record<string, unknown>;
    for (const name of [
      'GuardrailEvaluationIngestService',
      'GuardrailEvaluationAdminService',
      'GuardrailEvaluationServiceModule',
      'GuardrailNoticeService',
      'GuardrailNoticeServiceModule',
      'IGuardrailNoticeService',
      'GuardrailEvaluationBatchRequestDto',
      'GuardrailEvaluationListQuery',
      'ResumeGuardrailHoldRequest',
      'AcknowledgeGuardrailNoticeRequest',
      'ApproveResolveHoldRequest',
      'GuardrailNoticeListResponse',
      'ConsultationApprovalService',
      'NoteInputComposerService',
    ]) {
      expect(barrel[name], name).toBeDefined();
    }
  }, 120_000);
});
