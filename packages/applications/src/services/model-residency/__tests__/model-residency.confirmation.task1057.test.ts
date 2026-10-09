/**
 * TASK-1057 — the residency reason rule is the platform's action-confirmation policy. `when-risky` (the
 * default) is today's rule: a live-path / pinned model, or a load forced past the budget, needs a reason
 * (409 in the action's own shape). `not-required` never refuses for a missing reason; `required` asks for
 * one on every operation (400 CONFIRMATION_REQUIRED where no residency rule explains it). Every operation's
 * audit event carries the stamp — including "reason not required".
 */
import { describe, expect, it } from 'vitest';
import { GEMMA, GLIGUARD, NER, agentModel, audits, build, lmsModel, refusal } from './task1055-harness';

function nerLivePath(h: ReturnType<typeof build>): void {
  h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' })];
  h.state.livePath = [
    { service: 'nlp', modelRef: NER, aiModelId: 'model-ner', aiModelIds: ['model-ner'], tenantId: 't', agentSlug: 'ner', role: 'routing' },
  ];
}

const audit = (h: ReturnType<typeof build>, action: string) => audits(h).find((a) => a.action === action);

describe('modelResidency.unload', () => {
  it('default: a live-path unload without a reason is still 409 LIVE_PATH_REASON_REQUIRED', async () => {
    const h = build();
    nerLivePath(h);
    expect(await refusal(h.service.unload({ service: 'nlp', modelRef: NER }))).toMatchObject({
      status: 409,
      body: { code: 'LIVE_PATH_REASON_REQUIRED' },
    });
  });

  it('default: a live-path unload WITH a reason stamps "reason required"', async () => {
    const h = build();
    nerLivePath(h);
    await h.service.unload({ service: 'nlp', modelRef: NER, reason: 'free the card' });
    expect(audit(h, 'model-residency.unload')?.confirmation).toEqual({
      actionId: 'modelResidency.unload',
      kind: 'reason',
      mode: 'when-risky',
      locked: false,
      required: true,
      provided: true,
      note: 'reason required',
    });
  });

  it('not-required: a live-path unload proceeds without a reason and stamps "reason not required"', async () => {
    const h = build({ confirmationModes: { 'modelResidency.unload': 'not-required' } });
    nerLivePath(h);
    const result = await h.service.unload({ service: 'nlp', modelRef: NER });
    expect(result.outcome).toBe('unloaded');
    expect(audit(h, 'model-residency.unload')?.confirmation).toMatchObject({
      mode: 'not-required',
      required: false,
      provided: false,
      note: 'reason not required',
    });
  });

  it('required: an ordinary unload without a reason is 400 CONFIRMATION_REQUIRED', async () => {
    const h = build({ confirmationModes: { 'modelResidency.unload': 'required' } });
    h.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:1' })];
    expect(await refusal(h.service.unload({ service: 'nlp', modelRef: GLIGUARD }))).toMatchObject({
      status: 400,
      body: { code: 'CONFIRMATION_REQUIRED', actionId: 'modelResidency.unload', kind: 'reason' },
    });
    expect(h.agents.unload).not.toHaveBeenCalled();
  });
});

describe('modelResidency.reload (replace)', () => {
  it('default: a live-path replace without a reason is still 409 LIVE_PATH_REASON_REQUIRED', async () => {
    const h = build();
    nerLivePath(h);
    expect(await refusal(h.service.load({ service: 'nlp', modelRef: NER, replace: true }))).toMatchObject({
      status: 409,
      body: { code: 'LIVE_PATH_REASON_REQUIRED' },
    });
  });

  it('not-required: a live-path replace proceeds without a reason, stamped on the replace audit', async () => {
    const h = build({ confirmationModes: { 'modelResidency.reload': 'not-required' } });
    nerLivePath(h);
    const accepted = await h.service.load({ service: 'nlp', modelRef: NER, replace: true });
    expect(accepted.status).toBe(202);
    await h.service.drain();
    expect(audit(h, 'model-residency.replace')?.confirmation).toMatchObject({
      actionId: 'modelResidency.reload',
      required: false,
      note: 'reason not required',
    });
  });
});

describe('modelResidency.load', () => {
  it('default: a forced over-budget load without a reason keeps its 409 OVER_BUDGET', async () => {
    const h = build();
    expect(await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0', force: true }))).toMatchObject({
      status: 409,
      body: { code: 'OVER_BUDGET' },
    });
  });

  it('default: an ordinary load needs no reason and stamps "reason not required"', async () => {
    const h = build();
    const accepted = await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    expect(accepted.status).toBe(202);
    await h.service.drain();
    expect(audit(h, 'model-residency.load')?.confirmation).toMatchObject({
      actionId: 'modelResidency.load',
      mode: 'when-risky',
      required: false,
      note: 'reason not required',
    });
  });

  it('not-required: force alone lifts the budget refusal', async () => {
    const h = build({ confirmationModes: { 'modelResidency.load': 'not-required' } });
    const accepted = await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0', force: true });
    expect(accepted.status).toBe(202);
    await h.service.drain();
    expect(audit(h, 'model-residency.load')?.confirmation).toMatchObject({ required: false, provided: false });
  });

  it('required: an ordinary load without a reason is 400 CONFIRMATION_REQUIRED', async () => {
    const h = build({ confirmationModes: { 'modelResidency.load': 'required' } });
    expect(await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' }))).toMatchObject({
      status: 400,
      body: { code: 'CONFIRMATION_REQUIRED', actionId: 'modelResidency.load' },
    });
    expect(h.agents.load).not.toHaveBeenCalled();
  });
});

describe('lmStudioServing.apply (an LM Studio replace — the serving-profile "Apply & reload")', () => {
  it('default: an un-forced apply needs no reason and is stamped as the serving row', async () => {
    const h = build();
    const accepted = await h.service.load({ service: 'lm-studio', modelRef: GEMMA, replace: true, options: { contextLength: 4096 } });
    expect(accepted.status).toBe(202);
    await h.service.drain();
    expect(audit(h, 'model-residency.replace')?.confirmation).toMatchObject({ actionId: 'lmStudioServing.apply', required: false });
  });

  it('default: a FORCED apply without a reason is 400 CONFIRMATION_REQUIRED (the force path is the risk)', async () => {
    const h = build();
    h.state.models['lm-studio'] = [lmsModel({ inFlight: 2 })];
    expect(await refusal(h.service.load({ service: 'lm-studio', modelRef: GEMMA, replace: true, force: true }))).toMatchObject({
      status: 400,
      body: { code: 'CONFIRMATION_REQUIRED', actionId: 'lmStudioServing.apply' },
    });
  });

  it('not-required: a forced apply proceeds without a reason', async () => {
    const h = build({ confirmationModes: { 'lmStudioServing.apply': 'not-required' } });
    h.state.models['lm-studio'] = [lmsModel({ inFlight: 2 })];
    const accepted = await h.service.load({ service: 'lm-studio', modelRef: GEMMA, replace: true, force: true });
    expect(accepted.status).toBe(202);
    await h.service.drain();
    expect(audit(h, 'model-residency.replace')?.confirmation).toMatchObject({ actionId: 'lmStudioServing.apply', required: false });
  });
});
