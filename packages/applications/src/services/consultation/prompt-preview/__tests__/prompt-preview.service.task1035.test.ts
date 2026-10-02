/**
 * The Prompt Inspector service — a dry run of the prompt a real consultation would send.
 *
 *  - another tenant's consultation is a 404, and nothing is assembled;
 *  - CLOUD: `providerView` is what `apps/text` would send — detected and known identifiers as
 *    `[<LABEL>_<n>]` tokens, the platform token sentence appended to the system message;
 *  - LOCAL: no provider view, detection counted only;
 *  - an unresolvable model is CLOUD (fail closed);
 *  - a named agent composes ITS instruction (404 when it is not a published TEXT_GENERATION agent);
 *  - every preview is audited.
 */
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SysEventType } from '@arcaai/domains';
import { PLATFORM_TOKEN_SENTENCE, PromptPreviewService, splitSpans } from '../prompt-preview.service';

const TENANT = 'tenant-a';
const CID = 'c-1';
const SYSTEM = 'Rules. Patient Ada Lovelace.';
const USER = '<<<EXTERNAL_DATA section="transcript">>>\n--- TRANSCRIPT ---\nAda Lovelace reports MRN-77.\n<<<END_EXTERNAL_DATA>>>';

const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : undefined)), set: vi.fn() };
const events = { emit: vi.fn() };
const consultations = { findById: vi.fn() };
const agents = { findPublishedActiveBySlug: vi.fn() };
const harness = {
  previewAssembly: vi.fn(async () => ({
    systemPrompt: SYSTEM,
    userPrompt: USER,
    resolvedFrom: 'agent',
    hyperparameters: {},
    responseFormat: null,
    selected: ['base'],
    excluded: [{ key: 'revisit', reason: 'condition_false' }],
    blocks: [{ key: 'transcript', chars: 28, truncated: false }],
  })),
};
const detector = { detect: vi.fn() };
const policy = { resolveTextSelection: vi.fn() };
const knownPhi = { forConsultation: vi.fn(async () => [{ label: 'medical_record_number', value: 'MRN-77' }]) };

function service() {
  return new PromptPreviewService(
    consultations as never,
    agents as never,
    harness as never,
    detector as never,
    events as never,
    cls as never,
    policy as never,
    knownPhi as never,
    undefined as never,
  );
}

/** Spans in CODE POINTS of `system + "\n\n" + user`, as guardrail returns them. */
function spansFor(name: string) {
  const combined = `${SYSTEM}\n\n${USER}`;
  const spans = [];
  let from = 0;
  for (;;) {
    const at = combined.indexOf(name, from);
    if (at < 0) break;
    spans.push({ label: 'person', start: at, end: at + name.length });
    from = at + name.length;
  }
  return spans;
}

beforeEach(() => {
  vi.clearAllMocks();
  consultations.findById.mockResolvedValue({ id: CID, tenantId: TENANT, departmentId: 'dept-1' });
  detector.detect.mockResolvedValue(spansFor('Ada Lovelace'));
});

describe('PromptPreviewService', () => {
  it('CLOUD: shows the pseudonymized provider view, with the platform token sentence', async () => {
    policy.resolveTextSelection.mockResolvedValue({ provider: 'azure', model: 'gpt', deploymentKind: 'CLOUD' });

    const preview = await service().preview(CID, { phase: 'finalize' });

    expect(preview).toMatchObject({ system: SYSTEM, user: USER, locality: 'cloud', resolvedFrom: 'agent', selected: ['base'] });
    expect(preview.providerView).toEqual({
      system: `Rules. Patient [PERSON_1].\n\n${PLATFORM_TOKEN_SENTENCE}`,
      user: '<<<EXTERNAL_DATA section="transcript">>>\n--- TRANSCRIPT ---\n[PERSON_1] reports [MEDICAL_RECORD_NUMBER_1].\n<<<END_EXTERNAL_DATA>>>',
    });
    expect(preview.egressPreview).toEqual({ detected: { person: 2, medical_record_number: 1 }, redacted: 3 });
    expect(preview.tokenEstimate).toEqual({ system: Math.ceil(SYSTEM.length / 4), user: Math.ceil(USER.length / 4) });
    expect(detector.detect).toHaveBeenCalledWith(`${SYSTEM}\n\n${USER}`, TENANT);
  });

  it('LOCAL: no provider view; detection is counted only', async () => {
    policy.resolveTextSelection.mockResolvedValue({ provider: 'lm-studio', model: 'gemma', deploymentKind: 'SELF_HOSTED' });

    const preview = await service().preview(CID, { phase: 'live' });

    expect(preview.locality).toBe('local');
    expect(preview.providerView).toBeNull();
    expect(preview.egressPreview).toEqual({ detected: { person: 2, medical_record_number: 1 }, redacted: 0 });
    expect(harness.previewAssembly).toHaveBeenCalledWith(CID, expect.objectContaining({ tenantId: TENANT }), { phase: 'live' });
    expect(policy.resolveTextSelection).toHaveBeenCalledWith(TENANT, 'live', 'dept-1', null);
  });

  it('an unresolvable model is CLOUD — fail closed, as apps/text treats an unstamped provider', async () => {
    policy.resolveTextSelection.mockRejectedValue(new Error('no agent'));

    const preview = await service().preview(CID, { phase: 'finalize' });

    expect(preview.locality).toBe('cloud');
    expect(preview.providerView).not.toBeNull();
  });

  it('another tenant`s consultation is a 404, and nothing is assembled', async () => {
    consultations.findById.mockResolvedValue({ id: CID, tenantId: 'tenant-z' });

    await expect(service().preview(CID, { phase: 'finalize' })).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.previewAssembly).not.toHaveBeenCalled();
  });

  it('composes a NAMED agent`s frozen instruction; an unknown or non-text agent is a 404', async () => {
    policy.resolveTextSelection.mockResolvedValue({ provider: 'lm-studio', deploymentKind: 'SELF_HOSTED' });
    const frozen = { source: 'inline', content: 'AGENT BODY' };
    agents.findPublishedActiveBySlug.mockResolvedValue({ task: 'TEXT_GENERATION', compiledConfig: { resolvedPrompt: frozen }, instruction: { variables: { tone: { value: 'terse' } } } });

    await service().preview(CID, { phase: 'finalize', agentSlug: 'clinic-summarizer' });

    expect(harness.previewAssembly).toHaveBeenCalledWith(CID, expect.anything(), {
      phase: 'finalize',
      instructionOverride: { resolvedPrompt: frozen, variables: { tone: { value: 'terse' } } },
    });

    agents.findPublishedActiveBySlug.mockResolvedValue({ task: 'SPEECH_TO_TEXT' });
    await expect(service().preview(CID, { phase: 'finalize', agentSlug: 'asr' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('audits every preview, with metadata only', async () => {
    policy.resolveTextSelection.mockResolvedValue({ provider: 'azure', deploymentKind: 'CLOUD' });

    await service().preview(CID, { phase: 'pre-summary' });

    expect(events.emit).toHaveBeenCalledWith(
      SysEventType.ResourceViewed,
      expect.objectContaining({ resourceId: CID, forceAuditLog: true, data: { action: 'prompt-preview', phase: 'pre-summary', agentSlug: null, locality: 'cloud' } }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('Lovelace');
  });
});

describe('splitSpans — the mirror of apps/text `_split_spans`', () => {
  it('re-bases spans onto their segment and drops one crossing the separator', () => {
    const [a, b] = splitSpans(
      [
        { label: 'x', start: 0, end: 2 },
        { label: 'y', start: 5, end: 7 },
        { label: 'z', start: 2, end: 6 },
      ],
      ['abc', 'defg'],
    );
    expect(a).toEqual([{ label: 'x', start: 0, end: 2 }]);
    expect(b).toEqual([{ label: 'y', start: 0, end: 2 }]);
  });
});
