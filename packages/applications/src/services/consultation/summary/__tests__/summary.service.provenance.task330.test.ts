/**
 * SummaryService — getSummaryProvenance: expose harness
 * provenance over HTTP.
 *
 * The harness writes `SummaryMeta.citationsMap` + the sensor score columns
 * (coverageScore / entityFaithfulnessScore / ragTriadScore), its full sensor
 * detail object (persisted in the `guardrailDecisions` column), and `modelName`.
 * Until now those were only verifiable via the DB — no service/HTTP read path
 * surfaced them. This is the RED test for the read-only provenance accessor that
 * the consultation controller exposes.
 */

import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SummaryService } from '../summary.service';

function buildService(opts: { contextItemRepository?: unknown; transcriptSegmentRepository?: unknown } = {}) {
  const summaryMetaRepository = { findByContextItem: vi.fn() };
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue('tenant-1'), set: vi.fn() };

  const service = new SummaryService(
    (opts.contextItemRepository ?? {}) as never, // contextItemRepository
    {} as never, // consultationRepository
    summaryMetaRepository as never,
    {} as never, // namedEntityRepository
    {} as never, // httpService
    configService as never,
    eventEmitter as never,
    clsService as never,
    {} as never, // contextItemVersionRepository
    {} as never, // promptAssemblyService
    undefined, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    undefined, // harnessPolicyService
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // routingPolicies
    opts.transcriptSegmentRepository as never,
  );

  return { service, summaryMetaRepository };
}

describe('SummaryService.getSummaryProvenance (provenance over HTTP)', () => {
  it('maps SummaryMeta provenance (citationsMap + sensor scores + modelName) to a response DTO', async () => {
    const { service, summaryMetaRepository } = buildService();
    const generatedAt = new Date('2026-06-06T00:00:00.000Z');

    summaryMetaRepository.findByContextItem.mockResolvedValue({
      contextItemId: 'ctx-sum-1',
      modelName: 'gpt-x',
      entityFaithfulnessScore: 0.95,
      coverageScore: 0.9,
      ragTriadScore: 0.92,
      // Per-claim provenance map (what the harness writes to citationsMap).
      citationsMap: { claims: [{ id: 'claim-1', text: 'lisinopril', status: 'verified' }] },
      // The harness persists its full sensor-score detail in `guardrailDecisions`.
      guardrailDecisions: { entityFaithfulness: 0.95, coverage: 0.9, schemaValid: 1 },
      generatedAt,
    });

    const result = await service.getSummaryProvenance('ctx-sum-1');

    expect(summaryMetaRepository.findByContextItem).toHaveBeenCalledWith('ctx-sum-1');
    expect(result).toEqual({
      contextItemId: 'ctx-sum-1',
      modelName: 'gpt-x',
      entityFaithfulnessScore: 0.95,
      coverageScore: 0.9,
      ragTriadScore: 0.92,
      sensorScores: { entityFaithfulness: 0.95, coverage: 0.9, schemaValid: 1 },
      citationsMap: { claims: [{ id: 'claim-1', text: 'lisinopril', status: 'verified' }] },
      generatedAt: '2026-06-06T00:00:00.000Z',
      // TASK-932 R-16a — the redaction MARKER, now surfaced so "identifiers were replaced when
      // this note was finalized" is auditable over HTTP rather than only against the database.
      // `null` here because this fixture's meta declares none, which is deliberately distinct
      // from `false` ("the transform ran and changed nothing").
      redactionApplied: null,
      // No transcriptSegmentRepository wired in this fixture (
      // is best-effort) — degrades to [] rather than blocking the read.
      citedSegments: [],
    });
  });

  it('passes per-claim knowledgeChunkIds through provenance unchanged (Phase 3 institutional RAG)', async () => {
    // `knowledgeChunkIds: string[]` is added to each citationsMap claim
    // (the harness RAG path links a claim to the KnowledgeChunk rows that
    // grounded it). citationsMap is a Json passthrough end-to-end, so this is
    // surfaced verbatim — no schema/DTO change. This test locks that contract.
    const { service, summaryMetaRepository } = buildService();
    const citationsMap = {
      claims: [
        { id: 'claim-1', text: 'start lisinopril', status: 'verified', knowledgeChunkIds: ['kc-1', 'kc-2'] },
        { id: 'claim-2', text: 'monitor potassium', status: 'unverified', knowledgeChunkIds: [] },
      ],
    };
    summaryMetaRepository.findByContextItem.mockResolvedValue({
      contextItemId: 'ctx-rag-1',
      modelName: 'gpt-x',
      entityFaithfulnessScore: null,
      coverageScore: null,
      ragTriadScore: null,
      citationsMap,
      guardrailDecisions: null,
      generatedAt: null,
    });

    const result = await service.getSummaryProvenance('ctx-rag-1');

    expect(result.citationsMap).toEqual(citationsMap);
    const claims = (result.citationsMap as { claims: Array<{ knowledgeChunkIds: string[] }> }).claims;
    expect(claims[0].knowledgeChunkIds).toEqual(['kc-1', 'kc-2']);
    expect(claims[1].knowledgeChunkIds).toEqual([]);
  });

  it('normalises absent provenance to null fields (no SummaryMeta optional columns set)', async () => {
    const { service, summaryMetaRepository } = buildService();
    summaryMetaRepository.findByContextItem.mockResolvedValue({
      contextItemId: 'ctx-sum-2',
      modelName: null,
      entityFaithfulnessScore: null,
      coverageScore: null,
      ragTriadScore: null,
      citationsMap: null,
      guardrailDecisions: null,
      generatedAt: null,
    });

    const result = await service.getSummaryProvenance('ctx-sum-2');

    expect(result).toEqual({
      contextItemId: 'ctx-sum-2',
      modelName: null,
      entityFaithfulnessScore: null,
      coverageScore: null,
      ragTriadScore: null,
      sensorScores: null,
      citationsMap: null,
      generatedAt: null,
      redactionApplied: null,
      citedSegments: [],
    });
  });

  it('throws NotFoundException when no SummaryMeta exists for the summary', async () => {
    const { service, summaryMetaRepository } = buildService();
    summaryMetaRepository.findByContextItem.mockResolvedValue(null);

    await expect(service.getSummaryProvenance('missing-ctx')).rejects.toThrow(NotFoundException);
  });

  // Cited transcript segments, resolved against the
  // consultation's persisted TranscriptSegment rows.
  describe('citedSegments', () => {
    function buildWithSegments(segments: unknown[]) {
      const contextItemRepository = {
        findById: vi.fn().mockResolvedValue({ id: 'ctx-sum-1', consultationId: 'consult-1', tenantId: 'tenant-1' }),
        findTranscripts: vi.fn().mockResolvedValue([{ id: 'transcript-1' }]),
      };
      const transcriptSegmentRepository = { findByContextItem: vi.fn().mockResolvedValue(segments) };
      return buildService({ contextItemRepository, transcriptSegmentRepository });
    }

    it('resolves cited segments (flat segmentCitedIds) against the persisted transcript', async () => {
      const { service, summaryMetaRepository } = buildWithSegments([
        { id: 'seg-1', idx: 0, t0Ms: 0, t1Ms: 1500, speaker: 'doctor', charStart: 0, charEnd: 20 },
        { id: 'seg-2', idx: 1, t0Ms: 1500, t1Ms: 3000, speaker: 'patient', charStart: 20, charEnd: 40 },
        { id: 'seg-not-cited', idx: 2, t0Ms: 3000, t1Ms: 4000, speaker: 'doctor', charStart: 40, charEnd: 60 },
      ]);
      summaryMetaRepository.findByContextItem.mockResolvedValue({
        contextItemId: 'ctx-sum-1',
        modelName: null,
        entityFaithfulnessScore: null,
        coverageScore: null,
        ragTriadScore: null,
        citationsMap: { segmentCitedIds: ['seg-1', 'seg-2'] },
        guardrailDecisions: null,
        generatedAt: null,
      });

      const result = await service.getSummaryProvenance('ctx-sum-1');

      expect(result.citedSegments).toEqual([
        { id: 'seg-1', idx: 0, t0Ms: 0, t1Ms: 1500, speaker: 'doctor', charStart: 0, charEnd: 20 },
        { id: 'seg-2', idx: 1, t0Ms: 1500, t1Ms: 3000, speaker: 'patient', charStart: 20, charEnd: 40 },
      ]);
    });

    it('resolves cited segments from claims[].evidence[].segmentId (NER-claims lane)', async () => {
      const { service, summaryMetaRepository } = buildWithSegments([
        { id: 'seg-3', idx: 0, t0Ms: 0, t1Ms: 1000, speaker: null, charStart: 0, charEnd: 10 },
      ]);
      summaryMetaRepository.findByContextItem.mockResolvedValue({
        contextItemId: 'ctx-sum-1',
        modelName: null,
        entityFaithfulnessScore: null,
        coverageScore: null,
        ragTriadScore: null,
        citationsMap: { claims: [{ id: 'c1', evidence: [{ startOffset: 0, segmentId: 'seg-3' }] }] },
        guardrailDecisions: null,
        generatedAt: null,
      });

      const result = await service.getSummaryProvenance('ctx-sum-1');

      expect(result.citedSegments).toEqual([{ id: 'seg-3', idx: 0, t0Ms: 0, t1Ms: 1000, speaker: null, charStart: 0, charEnd: 10 }]);
    });

    it('degrades to [] (best-effort) when the consultation has more than one transcript', async () => {
      const contextItemRepository = {
        findById: vi.fn().mockResolvedValue({ id: 'ctx-sum-1', consultationId: 'consult-1', tenantId: 'tenant-1' }),
        findTranscripts: vi.fn().mockResolvedValue([{ id: 'transcript-1' }, { id: 'transcript-2' }]),
      };
      const transcriptSegmentRepository = { findByContextItem: vi.fn() };
      const { service, summaryMetaRepository } = buildService({ contextItemRepository, transcriptSegmentRepository });
      summaryMetaRepository.findByContextItem.mockResolvedValue({
        contextItemId: 'ctx-sum-1',
        modelName: null,
        entityFaithfulnessScore: null,
        coverageScore: null,
        ragTriadScore: null,
        citationsMap: { segmentCitedIds: ['seg-1'] },
        guardrailDecisions: null,
        generatedAt: null,
      });

      const result = await service.getSummaryProvenance('ctx-sum-1');

      expect(result.citedSegments).toEqual([]);
      expect(transcriptSegmentRepository.findByContextItem).not.toHaveBeenCalled();
    });

    it('degrades to [] (best-effort, no throw) when the transcript-segment lookup fails', async () => {
      const contextItemRepository = {
        findById: vi.fn().mockResolvedValue({ id: 'ctx-sum-1', consultationId: 'consult-1', tenantId: 'tenant-1' }),
        findTranscripts: vi.fn().mockResolvedValue([{ id: 'transcript-1' }]),
      };
      const transcriptSegmentRepository = { findByContextItem: vi.fn().mockRejectedValue(new Error('db down')) };
      const { service, summaryMetaRepository } = buildService({ contextItemRepository, transcriptSegmentRepository });
      summaryMetaRepository.findByContextItem.mockResolvedValue({
        contextItemId: 'ctx-sum-1',
        modelName: null,
        entityFaithfulnessScore: null,
        coverageScore: null,
        ragTriadScore: null,
        citationsMap: { segmentCitedIds: ['seg-1'] },
        guardrailDecisions: null,
        generatedAt: null,
      });

      const result = await service.getSummaryProvenance('ctx-sum-1');

      expect(result.citedSegments).toEqual([]);
    });

    it('skips segment resolution entirely (no repo calls) when citationsMap cites nothing', async () => {
      const contextItemRepository = { findById: vi.fn(), findTranscripts: vi.fn() };
      const transcriptSegmentRepository = { findByContextItem: vi.fn() };
      const { service, summaryMetaRepository } = buildService({ contextItemRepository, transcriptSegmentRepository });
      summaryMetaRepository.findByContextItem.mockResolvedValue({
        contextItemId: 'ctx-sum-1',
        modelName: null,
        entityFaithfulnessScore: null,
        coverageScore: null,
        ragTriadScore: null,
        citationsMap: null,
        guardrailDecisions: null,
        generatedAt: null,
      });

      const result = await service.getSummaryProvenance('ctx-sum-1');

      expect(result.citedSegments).toEqual([]);
      expect(contextItemRepository.findById).not.toHaveBeenCalled();
    });
  });
});
