/**
 * `ConsultationEndpointService`: DD-3 and DD-8, asserted.
 *
 * The two decisions this service exists to make true:
 *
 * * **DD-3** — `summary.finalize` locks **every** document, not just the SOAP note. A finalize
 *   scoped to one document leaves a discharge summary editable after signature, which is exactly
 *   the state a signature is supposed to end.
 * * **DD-8** — `feedback.capture` is the **only** path that promotes an advisory transcript
 *   correction over the raw channel. `consultation.proposeCorrections` returns its source text
 *   byte-identical and writes nothing; this is where a clinician's acceptance becomes real.
 *
 * Plus the property that makes both safe under Temporal: every operation is IDEMPOTENT, because
 * an `on-end` durable-lane activity WILL be retried.
 */
import { DocumentSectionState } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEndpointService } from '../consultation-endpoint.service';
import { ENDPOINT_REASON_ENDED, ENDPOINT_REASON_TIMED_OUT } from '../endpoint.constants';

const TENANT = 'tenant-1';
const CONSULTATION = 'consult-1';

/** One section row, shaped like the entity the repository returns. */
function section(documentKey: string, sectionKey: string, state: DocumentSectionState = DocumentSectionState.PROVISIONAL) {
  return {
    id: `${documentKey}:${sectionKey}`,
    tenantId: TENANT,
    consultationId: CONSULTATION,
    documentKey,
    sectionKey,
    state,
    version: 3,
    lockedAt: null as Date | null,
    hasChanges: true,
    lock(at?: Date) {
      this.state = DocumentSectionState.LOCKED;
      this.lockedAt = at ?? new Date();
    },
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, metadata: null, version: 1, hasChanges: false }),
    update: vi.fn().mockImplementation(async (_id: string, entity: unknown) => entity),
  };
  const documentSectionRepository = {
    findByConsultation: vi.fn().mockResolvedValue([]),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: unknown) => entity),
  };
  const contextItemRepository = { findTranscripts: vi.fn().mockResolvedValue([]) };
  const contextItemVersionRepository = {
    getLatestVersionNumber: vi.fn().mockResolvedValue(1),
    getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async (entity: unknown) => entity),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const eventEmitter = { emit: vi.fn(), emitAsync: vi.fn().mockResolvedValue([]) };
  const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn() };

  Object.assign({ consultationRepository, documentSectionRepository, contextItemRepository, contextItemVersionRepository }, overrides);

  const service = new ConsultationEndpointService(
    consultationRepository as never,
    documentSectionRepository as never,
    contextItemRepository as never,
    contextItemVersionRepository as never,
    eventEmitter as never,
    cls as never,
  );
  return { service, consultationRepository, documentSectionRepository, contextItemRepository, contextItemVersionRepository, eventEmitter };
}

// ===========================================================================
// DD-3 — finalize locks EVERY document
// ===========================================================================

describe('finalizeDocuments — DD-3: EVERY document locks, not just the SOAP note', () => {
  it('locks every section of every document of the consultation', async () => {
    const { service, documentSectionRepository } = makeService();
    const sections = [
      section('soap-note', 'subjective'),
      section('soap-note', 'assessment'),
      section('discharge-summary', 'medications'),
      section('referral-letter', 'reason'),
    ];
    documentSectionRepository.findByConsultation.mockResolvedValue(sections);

    const result = await service.finalizeDocuments(TENANT, CONSULTATION, {});

    // The test that would have caught a SOAP-only finalize: the discharge summary and the
    // referral letter are locked too, and the response names all three documents.
    expect(sections.every((s) => s.state === DocumentSectionState.LOCKED)).toBe(true);
    expect(result.documentKeys).toEqual(['discharge-summary', 'referral-letter', 'soap-note']);
    expect(result.lockedSections).toBe(4);
    expect(documentSectionRepository.updateWithVersion).toHaveBeenCalledTimes(4);
  });

  it('reads the CONSULTATION, never a single document — the scope cannot be narrowed', async () => {
    const { service, documentSectionRepository } = makeService();
    await service.finalizeDocuments(TENANT, CONSULTATION, {});
    expect(documentSectionRepository.findByConsultation).toHaveBeenCalledWith(TENANT, CONSULTATION);
  });

  it('locks CONFIRMED sections as well as PROVISIONAL ones — a signed encounter freezes whole', async () => {
    const { service, documentSectionRepository } = makeService();
    const sections = [section('soap-note', 'subjective', DocumentSectionState.CONFIRMED), section('soap-note', 'plan', DocumentSectionState.EMPTY)];
    documentSectionRepository.findByConsultation.mockResolvedValue(sections);

    await service.finalizeDocuments(TENANT, CONSULTATION, {});

    expect(sections.map((s) => s.state)).toEqual([DocumentSectionState.LOCKED, DocumentSectionState.LOCKED]);
  });

  it('lockConfirmedOnly leaves PROVISIONAL sections writable — opt-in, never the default', async () => {
    const { service, documentSectionRepository } = makeService();
    const confirmed = section('soap-note', 'subjective', DocumentSectionState.CONFIRMED);
    const provisional = section('soap-note', 'plan', DocumentSectionState.PROVISIONAL);
    documentSectionRepository.findByConsultation.mockResolvedValue([confirmed, provisional]);

    const result = await service.finalizeDocuments(TENANT, CONSULTATION, { lockConfirmedOnly: true });

    expect(confirmed.state).toBe(DocumentSectionState.LOCKED);
    expect(provisional.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(result.lockedSections).toBe(1);
    expect(result.skippedSections).toBe(1);
    // The document is still REPORTED — a caller must be able to see that a document exists and
    // was deliberately left partly open, rather than inferring it from a missing key.
    expect(result.documentKeys).toEqual(['soap-note']);
  });

  it('is IDEMPOTENT: a second pass locks nothing and writes nothing', async () => {
    const { service, documentSectionRepository } = makeService();
    const sections = [section('soap-note', 'subjective'), section('discharge-summary', 'meds')];
    documentSectionRepository.findByConsultation.mockResolvedValue(sections);

    const first = await service.finalizeDocuments(TENANT, CONSULTATION, {});
    documentSectionRepository.updateWithVersion.mockClear();
    const second = await service.finalizeDocuments(TENANT, CONSULTATION, {});

    expect(first.lockedSections).toBe(2);
    expect(second.lockedSections).toBe(0);
    expect(second.alreadyLocked).toBe(2);
    // The load-bearing half: a retry must not re-stamp `lockedAt`, or the audit trail says the
    // note was finalized at whatever time the last retry happened to land.
    expect(documentSectionRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(second.documentKeys).toEqual(['discharge-summary', 'soap-note']);
  });

  it('a consultation with no documents finalizes cleanly rather than failing', async () => {
    const { service } = makeService();
    const result = await service.finalizeDocuments(TENANT, CONSULTATION, {});
    expect(result).toEqual({ documentKeys: [], lockedSections: 0, alreadyLocked: 0, skippedSections: 0 });
  });
});

// ===========================================================================
// D-12 — the session disposition
// ===========================================================================

describe('recordSessionEndpoint — how the session ended', () => {
  it('stamps the disposition onto the consultation', async () => {
    const { service, consultationRepository } = makeService();
    const consultation = { id: CONSULTATION, tenantId: TENANT, metadata: null as unknown, version: 1, hasChanges: true };
    consultationRepository.findById.mockResolvedValue(consultation);

    const result = await service.recordSessionEndpoint(TENANT, CONSULTATION, {
      reason: ENDPOINT_REASON_TIMED_OUT,
      idleTimeoutSeconds: 900,
      sequence: ['session.timeout', 'summary.finalize'],
    });

    expect(result.recorded).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe(ENDPOINT_REASON_TIMED_OUT);
    const endpoint = (consultation.metadata as { endpoint: Record<string, unknown> }).endpoint;
    expect(endpoint.reason).toBe(ENDPOINT_REASON_TIMED_OUT);
    expect(endpoint.idleTimeoutSeconds).toBe(900);
    expect(endpoint.sequence).toEqual(['session.timeout', 'summary.finalize']);
  });

  it('is IDEMPOTENT: re-recording the same disposition changes nothing', async () => {
    const { service, consultationRepository } = makeService();
    const consultation = { id: CONSULTATION, tenantId: TENANT, metadata: null as unknown, version: 1, hasChanges: true };
    consultationRepository.findById.mockResolvedValue(consultation);

    await service.recordSessionEndpoint(TENANT, CONSULTATION, { reason: ENDPOINT_REASON_ENDED, sequence: [] });
    consultationRepository.update.mockClear();
    const second = await service.recordSessionEndpoint(TENANT, CONSULTATION, { reason: ENDPOINT_REASON_ENDED, sequence: [] });

    expect(second.recorded).toBe(true);
    expect(second.changed).toBe(false);
    expect(consultationRepository.update).not.toHaveBeenCalled();
  });

  it('preserves unrelated consultation metadata', async () => {
    const { service, consultationRepository } = makeService();
    const consultation = { id: CONSULTATION, tenantId: TENANT, metadata: { scheduling: { room: '3B' } } as unknown, version: 1, hasChanges: true };
    consultationRepository.findById.mockResolvedValue(consultation);

    await service.recordSessionEndpoint(TENANT, CONSULTATION, { reason: ENDPOINT_REASON_ENDED, sequence: [] });

    expect((consultation.metadata as Record<string, unknown>).scheduling).toEqual({ room: '3B' });
  });

  it('a cross-tenant consultation is NOT FOUND, never forbidden (404-over-403)', async () => {
    const { service, consultationRepository } = makeService();
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: 'other-tenant', metadata: null, version: 1 });

    await expect(service.recordSessionEndpoint(TENANT, CONSULTATION, { reason: ENDPOINT_REASON_ENDED, sequence: [] })).rejects.toThrow(/not found/i);
  });
});

// ===========================================================================
// DD-8 — the ONLY promotion path
// ===========================================================================

describe('captureFeedback — DD-8: the only path that promotes an advisory correction', () => {
  const TRANSCRIPT_TEXT = 'patient takes metformin 500mg daily';
  const transcriptItem = () => ({ id: 'ci-transcript', tenantId: TENANT, content: TRANSCRIPT_TEXT, currentVersionNumber: 1 });

  const proposal = (over: Record<string, unknown> = {}) => ({
    proposalId: 'p-1',
    // `metformin` sits at [14, 23) in TRANSCRIPT_TEXT. Offsets are literal on purpose: a
    // computed span would pass this test even if the service stopped verifying them.
    start: 14,
    end: 23,
    original: 'metformin',
    proposed: 'Metformin',
    category: 'drugName',
    confidence: 0.9,
    status: 'ACCEPTED',
    ...over,
  });

  it('promotes an accepted proposal as a new ContextItemVersion over the RAW channel', async () => {
    const { service, contextItemRepository, contextItemVersionRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([transcriptItem()]);

    const result = await service.captureFeedback(TENANT, CONSULTATION, { acceptedProposals: [proposal()], userId: 'u-1' });

    expect(result.captured).toBe(true);
    expect(result.promotedCount).toBe(1);
    expect(contextItemVersionRepository.create).toHaveBeenCalledTimes(1);

    const created = contextItemVersionRepository.create.mock.calls[0][0];
    // The raw item is never mutated — a promotion is a NEW version layered over it, so the raw
    // transcript stays recoverable. That is what "over the raw channel" means.
    expect(created.changeReason).toBe('correction');
    expect(created.changeSource).toMatch(/^feedback\.capture:/);
    expect(created.content).toBe('patient takes Metformin 500mg daily');
    expect(created.versionNumber).toBe(2);
  });

  it('refuses a proposal whose span no longer matches the raw text', async () => {
    const { service, contextItemRepository, contextItemVersionRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([transcriptItem()]);

    // The span says "metformin" but the raw text at [0,9) is "patient t" — splicing here would
    // land the replacement on the wrong characters.
    const result = await service.captureFeedback(TENANT, CONSULTATION, {
      acceptedProposals: [proposal({ start: 0, end: 9 })],
    });

    expect(result.promotedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(contextItemVersionRepository.create).not.toHaveBeenCalled();
  });

  it('refuses every proposal when the supplied digest does not match the raw text', async () => {
    const { service, contextItemRepository, contextItemVersionRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([transcriptItem()]);

    const result = await service.captureFeedback(TENANT, CONSULTATION, {
      acceptedProposals: [proposal()],
      textSha256: 'a'.repeat(64),
    });

    expect(result.promotedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(contextItemVersionRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a proposal that is not ACCEPTED — a PROPOSED one is advisory and stays advisory', async () => {
    const { service, contextItemRepository, contextItemVersionRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([transcriptItem()]);

    const result = await service.captureFeedback(TENANT, CONSULTATION, {
      acceptedProposals: [proposal({ status: 'PROPOSED' })],
    });

    expect(result.promotedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(contextItemVersionRepository.create).not.toHaveBeenCalled();
  });

  it('is IDEMPOTENT: a retry finds its own deterministic promotion key and promotes nothing', async () => {
    const { service, contextItemRepository, contextItemVersionRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([transcriptItem()]);

    const first = await service.captureFeedback(TENANT, CONSULTATION, { acceptedProposals: [proposal()] });

    // The retry sees the version the first pass wrote.
    contextItemVersionRepository.getVersionsByChangeReason.mockResolvedValue([{ changeSource: first.promotionKey }]);
    contextItemVersionRepository.create.mockClear();
    const second = await service.captureFeedback(TENANT, CONSULTATION, { acceptedProposals: [proposal()] });

    expect(second.alreadyPromoted).toBe(true);
    expect(second.promotedCount).toBe(0);
    expect(second.promotionKey).toBe(first.promotionKey);
    expect(contextItemVersionRepository.create).not.toHaveBeenCalled();
  });

  it('captures feedback with NO proposals at all — rating and comment are the common case', async () => {
    const { service, contextItemVersionRepository } = makeService();

    const result = await service.captureFeedback(TENANT, CONSULTATION, { rating: 4, comment: 'good note' });

    expect(result.captured).toBe(true);
    expect(result.promotedCount).toBe(0);
    expect(contextItemVersionRepository.create).not.toHaveBeenCalled();
  });

  it('degrades rather than throwing when the consultation has no transcript to correct', async () => {
    const { service, contextItemRepository } = makeService();
    contextItemRepository.findTranscripts.mockResolvedValue([]);

    const result = await service.captureFeedback(TENANT, CONSULTATION, { acceptedProposals: [proposal()] });

    expect(result.captured).toBe(true);
    expect(result.promotedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
  });
});
