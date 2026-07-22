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

function buildService() {
  const summaryMetaRepository = { findByContextItem: vi.fn() };
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue('tenant-1'), set: vi.fn() };

  const service = new SummaryService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    summaryMetaRepository as never,
    {} as never, // namedEntityRepository
    {} as never, // httpService
    configService as never,
    eventEmitter as never,
    clsService as never,
    {} as never, // contextItemVersionRepository
    {} as never, // promptAssemblyService
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
    });
  });

  it('throws NotFoundException when no SummaryMeta exists for the summary', async () => {
    const { service, summaryMetaRepository } = buildService();
    summaryMetaRepository.findByContextItem.mockResolvedValue(null);

    await expect(service.getSummaryProvenance('missing-ctx')).rejects.toThrow(NotFoundException);
  });
});
