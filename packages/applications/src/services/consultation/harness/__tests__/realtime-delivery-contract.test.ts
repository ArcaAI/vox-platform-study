/**
 * TASK-795 RC-1 / RC-2 — the realtime-delivery wire contract, gateway side.
 *
 * TASK-796 found that the harness cannot deliver clinical summary text to the
 * gateway at all: of the 18 `/internal/harness/*` routes, none accepts summary
 * text. The only text-accepting write is `.../draft`, which creates a
 * `RAW_SUMMARY` ContextItem — the FINAL note, the wrong kind, and precisely the
 * row the W1 exclusivity gate governs. So the interpreter's realtime summaries,
 * suggestions and correction proposals reached nothing.
 *
 * These two routes are the missing plane. The AUTHORITATIVE contract is
 * `apps/harness/src/harness/tests/unit/services/test_live_delivery_client.py`
 * (branch `feat/task-796-realtime-summary-text`); the bodies below are copied
 * from it verbatim, key for key, so a rename on either side fails here rather
 * than silently blanking a clinician's panel.
 *
 * The bodies are replayed through a pipe configured EXACTLY like `main.ts`.
 * That is not ceremony: the gateway runs `whitelist + forbidNonWhitelisted +
 * forbidUnknownValues`, so one undeclared key 400s the whole publish — which is
 * why the harness client prunes absent optionals instead of sending `null`.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { HarnessLiveAssistRequest, HarnessLiveSummaryRequest } from '../dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

const TENANT = '10000000-0000-0000-0000-000000000001';

/** Copied verbatim from `test_posts_the_snapshot_to_the_existing_live_summary_plane`. */
const FULL_LIVE_SUMMARY_BODY = {
  tenantId: TENANT,
  runningSummary: 'Cough for three days.',
  sections: [{ title: 'Subjective', content: 'Cough for three days.' }],
  source: 'interpreter',
  nodeType: 'consultation.realtimeSummary',
  ordinal: 1,
  total: 3,
  provider: 'lm-studio',
  model: 'a-model',
  taskKey: 'text.live',
  userId: 'u1',
  jobId: 'j1',
};

/** Copied verbatim from `test_omits_absent_optional_fields`. */
const MINIMAL_LIVE_SUMMARY_BODY = { tenantId: TENANT, runningSummary: 'x', sections: [], source: 'interpreter' };

/** Copied verbatim from `test_posts_suggestions_under_the_suggestions_kind`. */
const SUGGESTIONS_BODY = {
  tenantId: TENANT,
  kind: 'suggestions',
  nodeType: 'consultation.suggestions',
  suggestions: [
    { suggestionId: 'abc123', text: 'Ask about penicillin allergy', category: 'history', status: 'PROPOSED', proposedBy: 'lm-studio:a-model' },
  ],
};

/** Copied verbatim from `test_posts_a_proposal_first_corrections_envelope`. */
const CORRECTIONS_BODY = {
  tenantId: TENANT,
  kind: 'corrections',
  nodeType: 'consultation.proposeCorrections',
  corrections: {
    proposals: [
      {
        proposalId: 'def456',
        start: 19,
        end: 29,
        original: 'amoxicilin',
        proposed: 'amoxicillin',
        category: 'drugName',
        confidence: 0.96,
        rationale: 'misspelling',
        detectedBy: 'nlp.ner',
        proposedBy: 'lm-studio:a-model',
        status: 'PROPOSED',
      },
    ],
    applied: false,
    appliedCount: 0,
    rejectedProposals: 0,
    textSha256: '0'.repeat(64),
  },
};

const asSummary = { type: 'body' as const, metatype: HarnessLiveSummaryRequest };
const asAssist = { type: 'body' as const, metatype: HarnessLiveAssistRequest };

describe('RC-1 — HarnessLiveSummaryRequest', () => {
  it('accepts the full snapshot body the interpreter posts', async () => {
    await expect(pipe.transform(FULL_LIVE_SUMMARY_BODY, asSummary)).resolves.toMatchObject({
      runningSummary: 'Cough for three days.',
      nodeType: 'consultation.realtimeSummary',
      taskKey: 'text.live',
    });
  });

  it('accepts the pruned body — every optional genuinely optional', async () => {
    await expect(pipe.transform(MINIMAL_LIVE_SUMMARY_BODY, asSummary)).resolves.toBeDefined();
  });

  it('accepts an EMPTY running summary — a first flush may legitimately have no text yet', async () => {
    await expect(pipe.transform({ ...MINIMAL_LIVE_SUMMARY_BODY, runningSummary: '' }, asSummary)).resolves.toBeDefined();
  });

  it('rejects a body carrying an undeclared key', async () => {
    await expect(pipe.transform({ ...MINIMAL_LIVE_SUMMARY_BODY, entities: [] }, asSummary)).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * VERIFIED AGAINST THE PIPE, not against the contract's prose.
   *
   * `test_omits_absent_optional_fields` justifies the harness client's `_prune`
   * with "a `null` for an unset optional would 400 the whole publish". That is
   * not what happens: `class-validator`'s `@IsOptional()` skips validation for
   * BOTH `undefined` and `null`, so a null optional is accepted here — as it is
   * on every other DTO in this package.
   *
   * The prune is still worth keeping (a `null` would otherwise ride into the
   * published payload as `provider: null`), but it is belt-and-braces, not the
   * load-bearing rule the comment claims. `forbidNonWhitelisted` — pinned in the
   * test above — is the rule that actually bites, and it bites on UNDECLARED
   * keys, not on null values.
   */
  it('TOLERATES a null for an unset optional, contrary to the harness contract note', async () => {
    await expect(pipe.transform({ ...MINIMAL_LIVE_SUMMARY_BODY, provider: null }, asSummary)).resolves.toBeDefined();
  });

  it('rejects a section missing its content', async () => {
    await expect(
      pipe.transform({ ...MINIMAL_LIVE_SUMMARY_BODY, sections: [{ title: 'Subjective' }] }, asSummary),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the tenant — an unattributable clinical publish is a defect in the caller', async () => {
    const { tenantId: _dropped, ...withoutTenant } = MINIMAL_LIVE_SUMMARY_BODY;
    await expect(pipe.transform(withoutTenant, asSummary)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RC-2 — HarnessLiveAssistRequest', () => {
  it('accepts the suggestions body', async () => {
    await expect(pipe.transform(SUGGESTIONS_BODY, asAssist)).resolves.toMatchObject({ kind: 'suggestions' });
  });

  it('accepts the proposal-first corrections envelope', async () => {
    const parsed = (await pipe.transform(CORRECTIONS_BODY, asAssist)) as HarnessLiveAssistRequest;

    expect(parsed.kind).toBe('corrections');
    // `applied: false` is a SAFETY assertion — "nothing was written to the note" —
    // so it must survive both the harness client's prune and this pipe.
    expect(parsed.corrections?.applied).toBe(false);
    expect(parsed.corrections?.proposals?.[0]?.status).toBe('PROPOSED');
    expect(parsed.corrections?.proposals?.[0]?.start).toBe(19);
  });

  it('rejects a kind outside the two the interpreter emits', async () => {
    await expect(pipe.transform({ ...SUGGESTIONS_BODY, kind: 'diagnosis' }, asAssist)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an undeclared key inside a correction proposal', async () => {
    const body = structuredClone(CORRECTIONS_BODY) as Record<string, never>;
    (body.corrections as unknown as { proposals: Record<string, unknown>[] }).proposals[0].replacementText = 'x';
    await expect(pipe.transform(body, asAssist)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an undeclared key inside a suggestion', async () => {
    const body = structuredClone(SUGGESTIONS_BODY) as Record<string, never>;
    (body.suggestions as unknown as Record<string, unknown>[])[0].appliedAt = 'now';
    await expect(pipe.transform(body, asAssist)).rejects.toBeInstanceOf(BadRequestException);
  });
});
