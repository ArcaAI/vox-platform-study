/**
 * TASK-1050 W2e — the request DTOs of the guardrail routes under the gateway's strict pipe
 * (`whitelist + forbidNonWhitelisted + forbidUnknownValues`): the frozen evaluation fixture is a
 * valid ingest body, an undeclared field is refused, and the business/admin query bodies validate.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import fixture from '../../../../../../tests/contracts/guardrail-evaluation.fixture.json';
import runEvents from '../../../../../../tests/contracts/guardrail-run-events.fixture.json';
import { GuardrailEvaluationBatchRequestDto } from '../dto/guardrail-evaluation-batch.request';
import { GuardrailEvaluationListQuery } from '../dto/guardrail-evaluation-admin.dto';
import { AcknowledgeGuardrailNoticeRequest, ResumeGuardrailHoldRequest } from '../../guardrail-notice/dto/guardrail-notice.request';

const STRICT = { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

async function errorsOf<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body) as object, STRICT);
  const flat = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((error) => [`${prefix}${error.property}`, ...flat(error.children ?? [], `${prefix}${error.property}.`)]);
  return flat(errors);
}

/** The valid example notices of the run-events contract fixture (its `invalid` cases are not notices to accept). */
function exampleNotices(): unknown[] {
  return (runEvents as unknown as { notices: unknown[] }).notices;
}

describe('GuardrailEvaluationBatchRequestDto', () => {
  it('accepts the frozen contract batch', async () => {
    expect(await errorsOf(GuardrailEvaluationBatchRequestDto, fixture.batch)).toEqual([]);
  });

  it('accepts the contract`s example notices on a record', async () => {
    const notices = exampleNotices();
    expect(notices.length).toBeGreaterThan(0);
    const record = { ...fixture.batch.evaluations[0], notices };
    expect(await errorsOf(GuardrailEvaluationBatchRequestDto, { evaluations: [record] })).toEqual([]);
  });

  it('refuses an undeclared field, an unknown check id and an empty batch', async () => {
    const record = fixture.batch.evaluations[0];
    expect(await errorsOf(GuardrailEvaluationBatchRequestDto, { evaluations: [{ ...record, judgeReasoning: 'quotes PHI' }] })).toContain('evaluations.0.judgeReasoning');
    const badCheck = { ...record, checks: [{ ...record.checks[0], checkId: 'no_such_check' }] };
    expect(await errorsOf(GuardrailEvaluationBatchRequestDto, { evaluations: [badCheck] })).toContain('evaluations.0.checks.0.checkId');
    expect(await errorsOf(GuardrailEvaluationBatchRequestDto, { evaluations: [] })).toContain('evaluations');
  });
});

describe('notice / hold / admin request bodies', () => {
  it('validates the resume body (noticeId + one of the three resolutions)', async () => {
    expect(await errorsOf(ResumeGuardrailHoldRequest, { noticeId: 'n-1', resolution: 'item_excluded' })).toEqual([]);
    expect(await errorsOf(ResumeGuardrailHoldRequest, { noticeId: 'n-1', resolution: 'ignore' })).toContain('resolution');
    expect(await errorsOf(ResumeGuardrailHoldRequest, { resolution: 'acknowledged' })).toContain('noticeId');
  });

  it('accepts an empty ack body and a named clinician', async () => {
    expect(await errorsOf(AcknowledgeGuardrailNoticeRequest, {})).toEqual([]);
    expect(await errorsOf(AcknowledgeGuardrailNoticeRequest, { clinicianUserId: 'u-1' })).toEqual([]);
  });

  it('validates the admin list query filters', async () => {
    expect(await errorsOf(GuardrailEvaluationListQuery, { action: 'block', direction: 'outbound', check: 'leakage_judge', limit: '20' })).toEqual([]);
    expect(await errorsOf(GuardrailEvaluationListQuery, { action: 'nope' })).toContain('action');
    expect(await errorsOf(GuardrailEvaluationListQuery, { limit: '0' })).toContain('limit');
  });
});
